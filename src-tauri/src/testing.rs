//! Test doubles: a fake Jira that serves paged tickets and worklogs, scripted answers, and a clock that never really waits.

use crate::sync::{locked, CancelToken, Clock, Failure, JiraRead, Transport};
use serde_json::{json, Value};
use std::{
  collections::{BTreeMap, VecDeque},
  sync::Mutex,
  time::Duration,
};

pub const ME: &str = "acct-me";
pub const COLLEAGUE: &str = "acct-colleague";

#[derive(Clone)]
pub struct Entry { id: String, author: String, started: String, minutes: u64 }

impl Entry {
  /// A worklog by `author` that started at 09:00 on `day` (`YYYY-MM-DD`).
  pub fn new(id: &str, author: &str, day: &str, minutes: u64) -> Self {
    Self { id: id.to_owned(), author: author.to_owned(), started: format!("{day}T09:00:00.000+0100"), minutes }
  }

  fn json(&self) -> Value {
    json!({
      "id": self.id,
      "author": { "accountId": self.author, "displayName": format!("Person {}", self.author), "avatarUrls": { "24x24": "https://jira.test/avatar.png" } },
      "started": self.started,
      "timeSpentSeconds": self.minutes * 60,
      "comment": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": format!("Work {}", self.id) }] }] },
    })
  }
}

#[derive(Clone)]
pub struct Ticket { key: String, project: String, entries: Vec<Entry> }

impl Ticket {
  pub fn new(key: &str, entries: Vec<Entry>) -> Self {
    Self { key: key.to_owned(), project: key.split('-').next().unwrap_or(key).to_owned(), entries }
  }

  fn json(&self) -> Value {
    json!({
      "key": self.key,
      "fields": {
        "summary": format!("Summary of {}", self.key),
        "project": { "key": self.project },
        "issuetype": { "name": "Task", "iconUrl": "https://jira.test/task.svg" },
        "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
        "parent": { "key": "EPIC-1", "fields": { "summary": "The epic" } },
        "timeoriginalestimate": 7200,
        "timespent": 3600,
        "customfield_10010": "Platform",
      },
    })
  }
}

/// `count` tickets named `{prefix}-1` to `{prefix}-{count}`, each with one 30-minute worklog by `author` on `day`.
pub fn tickets(prefix: &str, count: usize, author: &str, day: &str) -> Vec<Ticket> {
  (1..=count).map(|n| Ticket::new(&format!("{prefix}-{n}"), vec![Entry::new(&format!("{prefix}-{n}-1"), author, day, 30)])).collect()
}

type Fault = Box<dyn Fn(&str, usize) -> Option<Failure> + Send + Sync>;

/// Serves `search/jql` and per-ticket worklog requests from in-memory tickets, a page at a time.
pub struct FakeJira {
  tickets: Vec<Ticket>,
  search_page: usize,
  worklog_page: usize,
  requests: Mutex<Vec<String>>,
  fault: Option<Fault>,
}

impl FakeJira {
  pub fn new(tickets: Vec<Ticket>) -> Self {
    Self { tickets, search_page: 100, worklog_page: 5000, requests: Mutex::new(Vec::new()), fault: None }
  }

  /// The most tickets Jira returns per search page, whatever is asked for.
  pub fn search_page(mut self, size: usize) -> Self { self.search_page = size; self }

  /// The most worklogs Jira returns per page, whatever is asked for.
  pub fn worklog_page(mut self, size: usize) -> Self { self.worklog_page = size; self }

  /// Called with every request path and its 1-based position; a returned failure replaces the normal answer.
  pub fn fault(mut self, fault: impl Fn(&str, usize) -> Option<Failure> + Send + Sync + 'static) -> Self {
    self.fault = Some(Box::new(fault));
    self
  }

  pub fn requests(&self) -> Vec<String> { locked(&self.requests).clone() }

  pub fn count(&self, needle: &str) -> usize { locked(&self.requests).iter().filter(|path| path.contains(needle)).count() }

  fn search(&self, query: &BTreeMap<String, String>) -> Value {
    let page = query.get("nextPageToken").and_then(|token| token.strip_prefix("tok/en+=:")).and_then(|number| number.parse().ok()).unwrap_or(0);
    let size = query.get("maxResults").and_then(|size| size.parse().ok()).unwrap_or(self.search_page).min(self.search_page);
    let (start, end) = (page * size, ((page + 1) * size).min(self.tickets.len()));
    let issues: Vec<Value> = self.tickets.get(start..end).unwrap_or_default().iter().map(Ticket::json).collect();
    if end >= self.tickets.len() { return json!({ "issues": issues, "isLast": true }); }
    json!({ "issues": issues, "isLast": false, "nextPageToken": format!("tok/en+=:{}", page + 1) })
  }

  fn worklogs(&self, key: &str, query: &BTreeMap<String, String>) -> Result<Value, Failure> {
    let Some(ticket) = self.tickets.iter().find(|ticket| ticket.key == key) else {
      return Err(Failure::Fatal("Jira: Issue does not exist or you do not have permission to see it.".to_string()));
    };
    let start: usize = query.get("startAt").and_then(|start| start.parse().ok()).unwrap_or(0);
    let size = query.get("maxResults").and_then(|size| size.parse().ok()).unwrap_or(self.worklog_page).min(self.worklog_page);
    let end = (start + size).min(ticket.entries.len());
    let worklogs: Vec<Value> = ticket.entries.get(start..end).unwrap_or_default().iter().map(Entry::json).collect();
    Ok(json!({ "startAt": start, "maxResults": size, "total": ticket.entries.len(), "worklogs": worklogs }))
  }
}

impl Transport for FakeJira {
  fn get_once(&self, path: &str) -> Result<Value, Failure> {
    let ordinal = {
      let mut requests = locked(&self.requests);
      requests.push(path.to_owned());
      requests.len()
    };
    if let Some(failure) = self.fault.as_ref().and_then(|fault| fault(path, ordinal)) { return Err(failure); }
    let url = url::Url::parse(&format!("https://jira.test{path}")).map_err(|_| Failure::Fatal(format!("Bad request path {path}")))?;
    let query: BTreeMap<String, String> = url.query_pairs().map(|(name, value)| (name.into_owned(), value.into_owned())).collect();
    match url.path().strip_prefix("/rest/api/3/issue/").and_then(|rest| rest.strip_suffix("/worklog")) {
      Some(key) => self.worklogs(key, &query),
      None if url.path() == "/rest/api/3/search/jql" => Ok(self.search(&query)),
      None => Err(Failure::Fatal(format!("Unexpected request {path}"))),
    }
  }
}

/// Answers each request from a script; the last answer repeats for every later request.
pub struct Scripted { script: Mutex<VecDeque<Result<Value, Failure>>>, paths: Mutex<Vec<String>> }

impl Scripted {
  pub fn new(script: Vec<Result<Value, Failure>>) -> Self { Self { script: Mutex::new(script.into()), paths: Mutex::new(Vec::new()) } }

  pub fn paths(&self) -> Vec<String> { locked(&self.paths).clone() }

  pub fn calls(&self) -> usize { locked(&self.paths).len() }
}

impl Transport for Scripted {
  fn get_once(&self, path: &str) -> Result<Value, Failure> {
    locked(&self.paths).push(path.to_owned());
    let mut script = locked(&self.script);
    let answer = if script.len() > 1 { script.pop_front() } else { script.front().cloned() };
    answer.unwrap_or(Ok(Value::Null))
  }
}

/// Lets paging be tested without the retry layer.
impl JiraRead for Scripted {
  fn get(&self, path: &str) -> Result<Value, Failure> { self.get_once(path) }
}

/// Time only moves when something sleeps, and sleeping takes no real time.
#[derive(Default)]
pub struct ManualClock { now: Mutex<Duration>, slept: Mutex<Vec<Duration>>, on_sleep: Option<Box<dyn Fn(Duration) + Send + Sync>> }

impl ManualClock {
  /// Runs `hook` at the start of every sleep, for example to cancel the load while it waits.
  pub fn on_sleep(mut self, hook: impl Fn(Duration) + Send + Sync + 'static) -> Self { self.on_sleep = Some(Box::new(hook)); self }

  pub fn slept(&self) -> Vec<Duration> { locked(&self.slept).clone() }
}

impl Clock for ManualClock {
  fn now(&self) -> Duration { *locked(&self.now) }

  fn sleep(&self, wait: Duration, cancel: &CancelToken) -> Result<(), Failure> {
    if let Some(hook) = &self.on_sleep { hook(wait); }
    cancel.check()?;
    locked(&self.slept).push(wait);
    *locked(&self.now) += wait;
    Ok(())
  }
}
