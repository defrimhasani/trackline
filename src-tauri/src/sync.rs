//! Reliable Jira reads: paging, retries, pacing, cancellation and an honest completeness report.

use crate::encode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
  collections::{BTreeMap, HashSet},
  sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex, MutexGuard, PoisonError},
  time::{Duration, Instant},
};

/// The most tickets one load reads. Reaching it is reported, never hidden.
pub const ISSUE_LIMIT: usize = 2000;
/// Requests in flight at once for one load.
pub const WORKERS: usize = 8;
const SEARCH_PAGE_SIZE: usize = 100;
const MAX_SEARCH_PAGES: usize = 100;
const WORKLOG_PAGE_SIZE: usize = 5000;
const MAX_WORKLOG_PAGES: usize = 50;
const MAX_BUSY_RETRIES: u32 = 3;
const MAX_NETWORK_RETRIES: u32 = 1;
const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);
const NETWORK_RETRY_WAIT: Duration = Duration::from_secs(1);
const FAILURE_STREAK_LIMIT: usize = 8;
const LISTED_TICKETS: usize = 3;
const LISTED_PROBLEMS: usize = 3;
const MAX_CHANNELS: usize = 16;
const MAX_TICKET_TEXT: usize = 64;
const RATE_LIMITED: &str = "Jira is limiting how fast Trackline can read right now. Wait a minute, then try again.";

pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> { mutex.lock().unwrap_or_else(PoisonError::into_inner) }

#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
  Cancelled,
  /// Jira rejected the credentials, so every later request would fail the same way.
  Unauthorized(String),
  /// Jira asked Trackline to slow down (429) or had a temporary fault (502-504).
  Busy { message: String, retry_after: Option<Duration> },
  /// The request never completed: timeout, DNS or connection trouble.
  Network(String),
  /// Anything else. Repeating the request would not help.
  Fatal(String),
}

impl Failure {
  pub fn message(&self) -> &str {
    match self {
      Self::Cancelled => "The Jira request was cancelled.",
      Self::Unauthorized(message) | Self::Network(message) | Self::Fatal(message) | Self::Busy { message, .. } => message,
    }
  }
}

/// Jira sends `Retry-After` as whole seconds.
pub fn parse_retry_after(value: &str) -> Option<Duration> { value.trim().parse().ok().map(Duration::from_secs) }

pub fn classify_status(status: u16, retry_after: Option<&str>, detail: Option<&str>) -> Failure {
  let retry_after = retry_after.and_then(parse_retry_after);
  let message = match (detail, status) {
    (Some(detail), _) => format!("Jira: {detail}"),
    (None, 403) => "Jira denied this action. Check your permissions for this issue.".to_string(),
    (None, _) => format!("Jira could not complete the request ({status})."),
  };
  match status {
    401 => Failure::Unauthorized("Jira rejected the site URL, email address, or API token.".to_string()),
    429 => Failure::Busy { message: RATE_LIMITED.to_string(), retry_after },
    502..=504 => Failure::Busy { message, retry_after },
    _ => Failure::Fatal(message),
  }
}

/// How long to wait before retrying a busy Jira, or `None` when the wait is too long to be worth it.
/// `attempt` counts the retries already made.
pub fn busy_delay(retry_after: Option<Duration>, attempt: u32) -> Option<Duration> {
  let wait = retry_after.map_or_else(|| Duration::from_secs(1 << attempt.min(5)), |wait| wait.max(Duration::from_secs(1)));
  (wait <= MAX_RETRY_WAIT).then_some(wait)
}

#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
  pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst); }
  pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) }
  pub fn check(&self) -> Result<(), Failure> { if self.is_cancelled() { Err(Failure::Cancelled) } else { Ok(()) } }
}

/// Identifies one load so that a newer load on the same channel replaces an older one.
/// Sequences are only compared within a session, so reloading the window can't leave later loads looking stale.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTicket { pub channel: String, pub session: String, pub sequence: u64 }

type LatestLoad = (String, u64, CancelToken);

#[derive(Default)]
pub struct Loads { latest: Mutex<BTreeMap<String, LatestLoad>> }

pub static LOADS: Loads = Loads::new();

impl Loads {
  pub const fn new() -> Self { Self { latest: Mutex::new(BTreeMap::new()) } }

  /// Registers a load. A newer load cancels the previous one on its channel, and a load that arrives
  /// after a newer one (out-of-order delivery) is cancelled straight away. Loads without a ticket are never cancelled.
  pub fn begin(&self, ticket: Option<&LoadTicket>) -> CancelToken {
    let token = CancelToken::default();
    let Some(ticket) = ticket else { return token };
    if ticket.channel.len() > MAX_TICKET_TEXT || ticket.session.len() > MAX_TICKET_TEXT { return token; }
    let mut latest = locked(&self.latest);
    if latest.len() >= MAX_CHANNELS && !latest.contains_key(&ticket.channel) { return token; }
    if let Some((session, sequence, previous)) = latest.get(&ticket.channel) {
      if *session == ticket.session && *sequence >= ticket.sequence {
        token.cancel();
        return token;
      }
      previous.cancel();
    }
    latest.insert(ticket.channel.clone(), (ticket.session.clone(), ticket.sequence, token.clone()));
    token
  }
}

/// One attempt at a Jira GET for a path such as `/rest/api/3/search/jql?jql=…`.
pub trait Transport: Sync { fn get_once(&self, path: &str) -> Result<Value, Failure>; }

/// A Jira read that already retries what is safe to retry.
pub trait JiraRead: Sync { fn get(&self, path: &str) -> Result<Value, Failure>; }

pub trait Clock: Sync {
  /// Time since an arbitrary start.
  fn now(&self) -> Duration;
  /// Waits, but stops early with `Cancelled` once the load is cancelled.
  fn sleep(&self, wait: Duration, cancel: &CancelToken) -> Result<(), Failure>;
}

pub struct SystemClock(Instant);

impl Default for SystemClock { fn default() -> Self { Self(Instant::now()) } }

impl Clock for SystemClock {
  fn now(&self) -> Duration { self.0.elapsed() }

  fn sleep(&self, wait: Duration, cancel: &CancelToken) -> Result<(), Failure> {
    let deadline = Instant::now() + wait;
    loop {
      cancel.check()?;
      let left = deadline.saturating_duration_since(Instant::now());
      if left.is_zero() { return Ok(()); }
      std::thread::sleep(left.min(Duration::from_millis(100)));
    }
  }
}

/// Reads Jira through `transport`, retrying only reads that are safe to repeat.
///
/// - Rate limits and gateway errors are retried a few times, honouring `Retry-After` when it is short enough.
/// - A dropped connection is retried once.
/// - Any pause is shared by every request of the load, so a rate limit slows all workers down together.
/// - Rejected credentials, or a run of requests that all give up, stop the load's remaining requests instead of
///   letting each one wait out its own timeouts.
pub struct Retrying<T, C> {
  transport: T,
  clock: C,
  cancel: CancelToken,
  resume_at: Mutex<Duration>,
  streak: AtomicUsize,
  halted: Mutex<Option<Failure>>,
}

impl<T: Transport, C: Clock> Retrying<T, C> {
  pub fn new(transport: T, clock: C, cancel: CancelToken) -> Self {
    Self { transport, clock, cancel, resume_at: Mutex::new(Duration::ZERO), streak: AtomicUsize::new(0), halted: Mutex::new(None) }
  }

  #[cfg(test)]
  pub fn clock(&self) -> &C { &self.clock }

  #[cfg(test)]
  pub fn transport(&self) -> &T { &self.transport }

  fn hold(&self, wait: Duration) {
    let until = self.clock.now() + wait;
    let mut resume_at = locked(&self.resume_at);
    if until > *resume_at { *resume_at = until; }
  }

  fn wait_turn(&self) -> Result<(), Failure> {
    loop {
      let wait = locked(&self.resume_at).saturating_sub(self.clock.now());
      if wait.is_zero() { return Ok(()); }
      self.clock.sleep(wait, &self.cancel)?;
    }
  }

  fn give_up(&self, failure: &Failure) {
    let stop = match failure {
      Failure::Unauthorized(_) => true,
      Failure::Busy { .. } | Failure::Network(_) => self.streak.fetch_add(1, Ordering::SeqCst) + 1 >= FAILURE_STREAK_LIMIT,
      Failure::Cancelled | Failure::Fatal(_) => false,
    };
    if stop { *locked(&self.halted) = Some(failure.clone()); }
  }
}

impl<T: Transport, C: Clock> JiraRead for Retrying<T, C> {
  fn get(&self, path: &str) -> Result<Value, Failure> {
    let (mut busy, mut dropped) = (0, 0);
    loop {
      self.cancel.check()?;
      if let Some(failure) = locked(&self.halted).clone() { return Err(failure); }
      self.wait_turn()?;
      let failure = match self.transport.get_once(path) {
        Ok(value) => { self.streak.store(0, Ordering::SeqCst); return Ok(value); }
        Err(failure) => failure,
      };
      let wait = match &failure {
        Failure::Busy { retry_after, .. } if busy < MAX_BUSY_RETRIES => {
          let wait = busy_delay(*retry_after, busy);
          busy += 1;
          wait
        }
        Failure::Network(_) if dropped < MAX_NETWORK_RETRIES => { dropped += 1; Some(NETWORK_RETRY_WAIT) }
        _ => None,
      };
      match wait {
        Some(wait) => self.hold(wait),
        None => { self.give_up(&failure); return Err(failure); }
      }
    }
  }
}

/// Runs `task` for every item on a small pool of threads and returns the results in item order.
/// Items that were never started because the load was cancelled come back as `None`.
pub fn run_pool<I: Sync, O: Send>(items: &[I], cancel: &CancelToken, task: impl Fn(&I) -> O + Sync) -> Vec<Option<O>> {
  let next = AtomicUsize::new(0);
  let results = Mutex::new(items.iter().map(|_| None).collect::<Vec<Option<O>>>());
  std::thread::scope(|scope| {
    for _ in 0..WORKERS.min(items.len()) {
      scope.spawn(|| {
        while !cancel.is_cancelled() {
          let index = next.fetch_add(1, Ordering::SeqCst);
          let Some(item) = items.get(index) else { break };
          let output = task(item);
          locked(&results)[index] = Some(output);
        }
      });
    }
  });
  results.into_inner().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, PartialEq)]
pub enum SearchGap {
  /// More tickets exist than `ISSUE_LIMIT`.
  Limit,
  /// A page after the first could not be read.
  Stopped(String),
}

pub struct Search { pub issues: Vec<Value>, pub gap: Option<SearchGap> }

fn stopped(issues: Vec<Value>, message: &str) -> Result<Search, Failure> {
  Ok(Search { issues, gap: Some(SearchGap::Stopped(message.to_owned())) })
}

/// Follows every page of a `search/jql` request, up to `limit` tickets.
/// `base` is the request path without paging parameters. A failure on the first page is an error;
/// a failure later on keeps the tickets already read and reports the gap.
pub fn search_all(api: &dyn JiraRead, cancel: &CancelToken, base: &str, limit: usize) -> Result<Search, Failure> {
  let mut issues: Vec<Value> = Vec::new();
  let mut seen = HashSet::new();
  let mut tokens = HashSet::new();
  let mut token: Option<String> = None;
  for page_number in 0..MAX_SEARCH_PAGES {
    cancel.check()?;
    let path = match &token {
      Some(token) => format!("{base}&maxResults={SEARCH_PAGE_SIZE}&nextPageToken={}", encode(token)),
      None => format!("{base}&maxResults={SEARCH_PAGE_SIZE}"),
    };
    let page = match api.get(&path) {
      Ok(page) => page,
      Err(Failure::Cancelled) => return Err(Failure::Cancelled),
      Err(failure) if page_number == 0 => return Err(failure),
      Err(failure) => return stopped(issues, failure.message()),
    };
    for issue in page["issues"].as_array().into_iter().flatten() {
      let Some(key) = issue["key"].as_str().filter(|key| !key.is_empty()) else { continue };
      if !seen.insert(key.to_owned()) { continue; }
      if issues.len() >= limit { return Ok(Search { issues, gap: Some(SearchGap::Limit) }); }
      issues.push(issue.clone());
    }
    let next = page["nextPageToken"].as_str().filter(|next| !next.is_empty());
    match (next, page["isLast"].as_bool()) {
      (None, Some(false)) => return stopped(issues, "Jira said more tickets were available but did not say how to load them."),
      (None, _) | (_, Some(true)) => return Ok(Search { issues, gap: None }),
      (Some(next), _) => {
        if !tokens.insert(next.to_owned()) { return stopped(issues, "Jira repeated a page of tickets."); }
        token = Some(next.to_owned());
      }
    }
  }
  stopped(issues, "Jira has more pages of tickets than Trackline will read.")
}

pub struct IssueRead<T> { pub items: Vec<T>, pub stopped: Option<Failure> }

/// Reads every page of one ticket's worklogs. `map` is applied to each new worklog on every page and decides
/// whether it is in scope (author, dates). Pages advance by the number of worklogs Jira really returned, and worklogs
/// repeated between pages are counted once. A failure on the first page is an error; a failure later on keeps what
/// was read and reports it.
pub fn read_worklogs<T>(api: &dyn JiraRead, cancel: &CancelToken, key: &str, window: (i64, i64), mut map: impl FnMut(&Value) -> Option<T>) -> Result<IssueRead<T>, Failure> {
  let (started_after, started_before) = window;
  let (mut items, mut seen, mut start_at) = (Vec::new(), HashSet::new(), 0usize);
  for page_number in 0..MAX_WORKLOG_PAGES {
    cancel.check()?;
    let path = format!("/rest/api/3/issue/{key}/worklog?startAt={start_at}&maxResults={WORKLOG_PAGE_SIZE}&startedAfter={started_after}&startedBefore={started_before}");
    let page = match api.get(&path) {
      Ok(page) => page,
      Err(Failure::Cancelled) => return Err(Failure::Cancelled),
      Err(failure) if page_number == 0 => return Err(failure),
      Err(failure) => return Ok(IssueRead { items, stopped: Some(failure) }),
    };
    let logs = page["worklogs"].as_array().map_or(&[][..], Vec::as_slice);
    let mut fresh = 0;
    for log in logs {
      let id = log["id"].as_str().unwrap_or_default();
      if !id.is_empty() && !seen.insert(id.to_owned()) { continue; }
      fresh += 1;
      if let Some(item) = map(log) { items.push(item); }
    }
    start_at += logs.len();
    if logs.is_empty() || page["total"].as_u64().is_some_and(|total| start_at as u64 >= total) { return Ok(IssueRead { items, stopped: None }); }
    if fresh == 0 { return Ok(IssueRead { items, stopped: Some(Failure::Fatal("Jira repeated a page of worklogs.".to_string())) }); }
  }
  Ok(IssueRead { items, stopped: Some(Failure::Fatal("This ticket has more worklogs than Trackline will read.".to_string())) })
}

pub struct IssueGap { pub key: String, pub message: String }

/// Reads the worklogs of every ticket in parallel. A ticket that can't be read is reported as a gap and the rest
/// still load; cancellation is the only thing that fails the whole load.
pub fn gather<I: Sync, T: Send>(
  api: &dyn JiraRead, cancel: &CancelToken, issues: &[I], key_of: impl Fn(&I) -> &str + Sync,
  window: (i64, i64), map: impl Fn(&I, &Value) -> Option<T> + Sync,
) -> Result<(Vec<T>, Vec<IssueGap>), Failure> {
  let reads = run_pool(issues, cancel, |issue| read_worklogs(api, cancel, key_of(issue), window, |log| map(issue, log)));
  cancel.check()?;
  let (mut items, mut gaps) = (Vec::new(), Vec::new());
  for (issue, read) in issues.iter().zip(reads) {
    let problem = match read {
      Some(Ok(read)) => { items.extend(read.items); read.stopped.map(|failure| failure.message().to_owned()) }
      Some(Err(failure)) => Some(failure.message().to_owned()),
      None => Some("Trackline stopped before reading this ticket.".to_string()),
    };
    if let Some(message) = problem { gaps.push(IssueGap { key: key_of(issue).to_owned(), message }); }
  }
  Ok((items, gaps))
}

/// Whether a load covers everything Jira has for the request, and if not, why in plain language.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus { pub complete: bool, pub problems: Vec<String> }

fn name_tickets(keys: &[&str]) -> String {
  let shown = &keys[..keys.len().min(LISTED_TICKETS)];
  let rest = keys.len() - shown.len();
  let mut names: Vec<String> = shown.iter().map(|key| (*key).to_owned()).collect();
  if rest > 0 { names.push(format!("{rest} more {}", if rest == 1 { "ticket" } else { "tickets" })); }
  match names.split_last() {
    Some((last, [])) => last.clone(),
    Some((last, head)) => format!("{} and {last}", head.join(", ")),
    None => String::new(),
  }
}

impl SyncStatus {
  pub fn complete() -> Self { Self { complete: true, problems: Vec::new() } }

  pub fn describe(search: Option<&SearchGap>, issues: &[IssueGap]) -> Self {
    let mut problems = Vec::new();
    match search {
      Some(SearchGap::Limit) => problems.push(format!("Trackline stopped after {ISSUE_LIMIT} tickets, so some worklogs may be missing. Try a shorter period or narrow the scope.")),
      Some(SearchGap::Stopped(message)) => problems.push(format!("Trackline could not finish listing tickets, so some worklogs may be missing. {message}")),
      None => {}
    }
    let mut groups: Vec<(&str, Vec<&str>)> = Vec::new();
    for gap in issues {
      match groups.iter_mut().find(|(message, _)| *message == gap.message) {
        Some((_, keys)) => keys.push(&gap.key),
        None => groups.push((&gap.message, vec![&gap.key])),
      }
    }
    for (message, keys) in groups.iter().take(LISTED_PROBLEMS) {
      problems.push(format!("Worklogs for {} could not be loaded. {message}", name_tickets(keys)));
    }
    if groups.len() > LISTED_PROBLEMS { problems.push(format!("{} other kinds of problems were also found.", groups.len() - LISTED_PROBLEMS)); }
    Self { complete: problems.is_empty(), problems }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::testing::{tickets, FakeJira, ManualClock, Scripted, ME};
  use serde_json::json;

  fn secs(seconds: u64) -> Duration { Duration::from_secs(seconds) }
  fn busy(retry_after: Option<u64>) -> Failure { Failure::Busy { message: "busy".to_string(), retry_after: retry_after.map(secs) } }
  fn dropped() -> Failure { Failure::Network("offline".to_string()) }
  fn fatal() -> Failure { Failure::Fatal("no".to_string()) }
  fn ok() -> Result<Value, Failure> { Ok(json!({ "ok": true })) }

  fn retrying(script: Vec<Result<Value, Failure>>) -> Retrying<Scripted, ManualClock> {
    Retrying::new(Scripted::new(script), ManualClock::default(), CancelToken::default())
  }

  #[test]
  fn retry_after_is_whole_seconds() {
    assert_eq!(parse_retry_after("5"), Some(secs(5)));
    assert_eq!(parse_retry_after(" 7 "), Some(secs(7)));
    for value in ["", "soon", "-1", "1.5", "Wed, 21 Oct 2015 07:28:00 GMT"] { assert_eq!(parse_retry_after(value), None, "{value}"); }
  }

  #[test]
  fn statuses_are_sorted_into_what_can_be_retried() {
    assert_eq!(classify_status(401, None, Some("ignored")), Failure::Unauthorized("Jira rejected the site URL, email address, or API token.".to_string()));
    assert_eq!(classify_status(429, Some("7"), None), Failure::Busy { message: RATE_LIMITED.to_string(), retry_after: Some(secs(7)) });
    assert_eq!(classify_status(429, Some("later"), Some("Rate limit exceeded")), Failure::Busy { message: RATE_LIMITED.to_string(), retry_after: None });
    assert_eq!(classify_status(503, None, None), Failure::Busy { message: "Jira could not complete the request (503).".to_string(), retry_after: None });
    assert_eq!(classify_status(502, Some("3"), Some("Bad gateway")), Failure::Busy { message: "Jira: Bad gateway".to_string(), retry_after: Some(secs(3)) });
  }

  #[test]
  fn other_statuses_keep_their_messages_and_are_not_retried() {
    assert_eq!(classify_status(403, None, None), Failure::Fatal("Jira denied this action. Check your permissions for this issue.".to_string()));
    assert_eq!(classify_status(404, None, Some("Issue does not exist")), Failure::Fatal("Jira: Issue does not exist".to_string()));
    assert_eq!(classify_status(500, None, None), Failure::Fatal("Jira could not complete the request (500).".to_string()));
    assert_eq!(classify_status(400, Some("5"), Some("Bad JQL")), Failure::Fatal("Jira: Bad JQL".to_string()));
  }

  #[test]
  fn busy_waits_follow_retry_after_or_back_off() {
    assert_eq!(busy_delay(Some(secs(5)), 0), Some(secs(5)));
    assert_eq!(busy_delay(Some(secs(0)), 2), Some(secs(1)));
    assert_eq!(busy_delay(Some(MAX_RETRY_WAIT), 0), Some(MAX_RETRY_WAIT));
    assert_eq!(busy_delay(Some(MAX_RETRY_WAIT + secs(1)), 0), None);
    assert_eq!([0, 1, 2].map(|attempt| busy_delay(None, attempt)), [Some(secs(1)), Some(secs(2)), Some(secs(4))]);
  }

  #[test]
  fn a_rate_limit_is_retried_after_the_wait_jira_asks_for() {
    let api = retrying(vec![Err(busy(Some(7))), ok()]);
    assert!(api.get("/x").is_ok());
    assert_eq!(api.transport().calls(), 2);
    assert_eq!(api.clock().slept(), [secs(7)]);
  }

  #[test]
  fn a_rate_limit_without_retry_after_backs_off_and_then_gives_up() {
    let api = retrying(vec![Err(busy(None))]);
    assert_eq!(api.get("/x"), Err(busy(None)));
    assert_eq!(api.transport().calls(), 4);
    assert_eq!(api.clock().slept(), [secs(1), secs(2), secs(4)]);
  }

  #[test]
  fn a_request_can_recover_on_its_last_retry() {
    let api = retrying(vec![Err(busy(None)), Err(busy(None)), Err(busy(None)), ok()]);
    assert!(api.get("/x").is_ok());
    assert_eq!(api.transport().calls(), 4);
  }

  #[test]
  fn errors_that_repeating_cannot_fix_are_not_retried() {
    let api = retrying(vec![Err(fatal())]);
    assert_eq!(api.get("/x"), Err(fatal()));
    assert_eq!(api.transport().calls(), 1);
    assert!(api.clock().slept().is_empty());
  }

  #[test]
  fn a_dropped_connection_is_retried_once() {
    let api = retrying(vec![Err(dropped()), ok()]);
    assert!(api.get("/x").is_ok());
    assert_eq!(api.clock().slept(), [NETWORK_RETRY_WAIT]);
    let api = retrying(vec![Err(dropped())]);
    assert_eq!(api.get("/x"), Err(dropped()));
    assert_eq!(api.transport().calls(), 2);
  }

  #[test]
  fn a_long_retry_after_is_not_waited_out() {
    let api = retrying(vec![Err(busy(Some(120)))]);
    assert_eq!(api.get("/x"), Err(busy(Some(120))));
    assert_eq!(api.transport().calls(), 1);
    assert!(api.clock().slept().is_empty());
  }

  #[test]
  fn after_rejected_credentials_later_requests_never_reach_jira() {
    let rejected = Failure::Unauthorized("rejected".to_string());
    let api = retrying(vec![Err(rejected.clone())]);
    assert_eq!(api.get("/a"), Err(rejected.clone()));
    assert_eq!(api.get("/b"), Err(rejected));
    assert_eq!(api.transport().calls(), 1);
  }

  #[test]
  fn a_run_of_requests_that_all_give_up_stops_the_load() {
    let api = retrying(vec![Err(dropped())]);
    for _ in 0..FAILURE_STREAK_LIMIT { assert_eq!(api.get("/x"), Err(dropped())); }
    let calls = api.transport().calls();
    assert_eq!(calls, FAILURE_STREAK_LIMIT * 2);
    assert_eq!(api.get("/y"), Err(dropped()));
    assert_eq!(api.transport().calls(), calls);
  }

  #[test]
  fn a_success_resets_the_run_of_failures() {
    let mut script = Vec::new();
    for _ in 0..2 {
      for _ in 1..FAILURE_STREAK_LIMIT { script.extend([Err(dropped()), Err(dropped())]); }
      script.push(ok());
    }
    let api = retrying(script);
    for _ in 0..2 {
      for _ in 1..FAILURE_STREAK_LIMIT { assert!(api.get("/x").is_err()); }
      assert!(api.get("/x").is_ok());
    }
  }

  #[test]
  fn cancelling_before_a_request_sends_nothing() {
    let cancel = CancelToken::default();
    let api = Retrying::new(Scripted::new(vec![ok()]), ManualClock::default(), cancel.clone());
    cancel.cancel();
    assert_eq!(api.get("/x"), Err(Failure::Cancelled));
    assert_eq!(api.transport().calls(), 0);
  }

  #[test]
  fn cancelling_during_a_backoff_stops_the_wait() {
    let cancel = CancelToken::default();
    let clock = ManualClock::default().on_sleep({ let cancel = cancel.clone(); move |_| cancel.cancel() });
    let api = Retrying::new(Scripted::new(vec![Err(busy(Some(5)))]), clock, cancel);
    assert_eq!(api.get("/x"), Err(Failure::Cancelled));
    assert_eq!(api.transport().calls(), 1);
  }

  #[test]
  fn a_pause_is_honoured_before_any_request_is_sent() {
    let api = retrying(vec![ok()]);
    api.hold(secs(5));
    assert!(api.get("/x").is_ok());
    assert_eq!(api.clock().slept(), [secs(5)]);
  }

  #[test]
  fn pooled_results_keep_item_order() {
    let items: Vec<usize> = (0..100).collect();
    let results = run_pool(&items, &CancelToken::default(), |item| item * 2);
    assert_eq!(results, items.iter().map(|item| Some(item * 2)).collect::<Vec<_>>());
  }

  #[test]
  fn the_pool_never_exceeds_its_worker_limit() {
    let items: Vec<usize> = (0..64).collect();
    let (running, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
    run_pool(&items, &CancelToken::default(), |_| {
      peak.fetch_max(running.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
      std::thread::sleep(Duration::from_millis(5));
      running.fetch_sub(1, Ordering::SeqCst);
    });
    let peak = peak.load(Ordering::SeqCst);
    assert!(peak > 1 && peak <= WORKERS, "{peak} at once");
  }

  #[test]
  fn cancelling_stops_the_pool_from_starting_more_work() {
    let items: Vec<usize> = (0..100).collect();
    let cancel = CancelToken::default();
    let results = run_pool(&items, &cancel, |item| {
      if *item == 0 { cancel.cancel(); } else { while !cancel.is_cancelled() { std::thread::sleep(Duration::from_millis(1)); } }
    });
    let started = results.iter().flatten().count();
    assert!((1..=WORKERS).contains(&started), "{started} items ran");
  }

  fn load(channel: &str, session: &str, sequence: u64) -> LoadTicket { LoadTicket { channel: channel.to_string(), session: session.to_string(), sequence } }

  #[test]
  fn a_newer_load_cancels_the_one_before_it() {
    let loads = Loads::new();
    let first = loads.begin(Some(&load("team", "s", 1)));
    let second = loads.begin(Some(&load("team", "s", 2)));
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
  }

  #[test]
  fn a_load_that_arrives_after_a_newer_one_is_cancelled_straight_away() {
    let loads = Loads::new();
    let newest = loads.begin(Some(&load("team", "s", 5)));
    let late = loads.begin(Some(&load("team", "s", 3)));
    let repeat = loads.begin(Some(&load("team", "s", 5)));
    assert!(late.is_cancelled() && repeat.is_cancelled());
    assert!(!newest.is_cancelled());
  }

  #[test]
  fn channels_do_not_cancel_each_other() {
    let loads = Loads::new();
    let calendar = loads.begin(Some(&load("calendar", "s", 1)));
    let team = loads.begin(Some(&load("team", "s", 1)));
    assert!(!calendar.is_cancelled() && !team.is_cancelled());
  }

  #[test]
  fn a_reloaded_window_starts_over_without_looking_stale() {
    let loads = Loads::new();
    let before = loads.begin(Some(&load("team", "old", 99)));
    let after = loads.begin(Some(&load("team", "new", 1)));
    assert!(before.is_cancelled());
    assert!(!after.is_cancelled());
  }

  #[test]
  fn loads_without_a_ticket_are_never_cancelled() {
    let loads = Loads::new();
    let tracked = loads.begin(Some(&load("calendar", "s", 1)));
    let (first, second) = (loads.begin(None), loads.begin(None));
    assert!(!tracked.is_cancelled() && !first.is_cancelled() && !second.is_cancelled());
  }

  #[test]
  fn oversized_tickets_are_not_tracked() {
    let loads = Loads::new();
    let long = "x".repeat(MAX_TICKET_TEXT + 1);
    let first = loads.begin(Some(&load(&long, "s", 2)));
    let repeat = loads.begin(Some(&load(&long, "s", 1)));
    assert!(!first.is_cancelled() && !repeat.is_cancelled());
  }

  #[test]
  fn only_a_bounded_number_of_channels_are_tracked() {
    let loads = Loads::new();
    let first = loads.begin(Some(&load("c0", "s", 1)));
    for channel in 1..MAX_CHANNELS { loads.begin(Some(&load(&format!("c{channel}"), "s", 1))); }
    assert!(!loads.begin(Some(&load("extra", "s", 2))).is_cancelled());
    assert!(!loads.begin(Some(&load("extra", "s", 1))).is_cancelled());
    assert!(!first.is_cancelled());
    loads.begin(Some(&load("c0", "s", 2)));
    assert!(first.is_cancelled());
  }

  fn gap(key: &str, message: &str) -> IssueGap { IssueGap { key: key.to_string(), message: message.to_string() } }

  #[test]
  fn a_load_without_gaps_is_complete() {
    assert_eq!(SyncStatus::describe(None, &[]), SyncStatus::complete());
    assert!(SyncStatus::complete().complete);
  }

  #[test]
  fn reaching_the_ticket_limit_is_reported() {
    let status = SyncStatus::describe(Some(&SearchGap::Limit), &[]);
    assert!(!status.complete);
    assert_eq!(status.problems, ["Trackline stopped after 2000 tickets, so some worklogs may be missing. Try a shorter period or narrow the scope."]);
  }

  #[test]
  fn an_unfinished_ticket_search_is_reported_with_its_reason() {
    let status = SyncStatus::describe(Some(&SearchGap::Stopped("Jira: boom".to_string())), &[]);
    assert!(!status.complete);
    assert_eq!(status.problems, ["Trackline could not finish listing tickets, so some worklogs may be missing. Jira: boom"]);
  }

  #[test]
  fn tickets_with_the_same_problem_are_reported_together() {
    let gaps: Vec<IssueGap> = ["TRK-1", "TRK-2", "TRK-3", "TRK-4", "TRK-5"].map(|key| gap(key, "Jira could not complete the request (500).")).into();
    let status = SyncStatus::describe(None, &gaps);
    assert!(!status.complete);
    assert_eq!(status.problems, ["Worklogs for TRK-1, TRK-2, TRK-3 and 2 more tickets could not be loaded. Jira could not complete the request (500)."]);
  }

  #[test]
  fn only_a_few_kinds_of_problems_are_listed() {
    let gaps: Vec<IssueGap> = (1..=5).map(|n| gap(&format!("TRK-{n}"), &format!("Problem {n}."))).collect();
    let status = SyncStatus::describe(None, &gaps);
    assert_eq!(status.problems.len(), LISTED_PROBLEMS + 1);
    assert_eq!(status.problems[0], "Worklogs for TRK-1 could not be loaded. Problem 1.");
    assert_eq!(status.problems[LISTED_PROBLEMS], "2 other kinds of problems were also found.");
  }

  #[test]
  fn tickets_are_named_in_plain_language() {
    assert_eq!(name_tickets(&["A"]), "A");
    assert_eq!(name_tickets(&["A", "B"]), "A and B");
    assert_eq!(name_tickets(&["A", "B", "C"]), "A, B and C");
    assert_eq!(name_tickets(&["A", "B", "C", "D"]), "A, B, C and 1 more ticket");
    assert_eq!(name_tickets(&["A", "B", "C", "D", "E"]), "A, B, C and 2 more tickets");
  }

  #[test]
  fn the_status_reaches_the_interface_in_camel_case() {
    let status = serde_json::to_value(SyncStatus::describe(Some(&SearchGap::Limit), &[])).unwrap();
    assert_eq!(status["complete"], false);
    assert_eq!(status["problems"].as_array().map(Vec::len), Some(1));
  }

  fn issues_page(keys: &[&str], next: Option<&str>) -> Result<Value, Failure> {
    let issues: Vec<Value> = keys.iter().map(|key| json!({ "key": key })).collect();
    Ok(match next {
      Some(token) => json!({ "issues": issues, "nextPageToken": token, "isLast": false }),
      None => json!({ "issues": issues, "isLast": true }),
    })
  }

  fn keys(search: &Search) -> Vec<&str> { search.issues.iter().filter_map(|issue| issue["key"].as_str()).collect() }

  fn search(script: Vec<Result<Value, Failure>>, limit: usize) -> (Result<Search, Failure>, Scripted) {
    let api = Scripted::new(script);
    (search_all(&api, &CancelToken::default(), "/search?jql=x", limit), api)
  }

  #[test]
  fn every_page_of_tickets_is_followed_by_its_token() {
    let (result, api) = search(vec![issues_page(&["A", "B"], Some("t/1")), issues_page(&["C"], Some("t+2")), issues_page(&["D"], None)], 100);
    let found = result.unwrap();
    assert_eq!(keys(&found), ["A", "B", "C", "D"]);
    assert_eq!(found.gap, None);
    assert_eq!(api.paths(), [
      "/search?jql=x&maxResults=100",
      "/search?jql=x&maxResults=100&nextPageToken=t%2F1",
      "/search?jql=x&maxResults=100&nextPageToken=t%2B2",
    ]);
  }

  #[test]
  fn a_last_page_without_the_last_flag_still_ends_the_search() {
    let (result, api) = search(vec![Ok(json!({ "issues": [{ "key": "A" }] }))], 100);
    let found = result.unwrap();
    assert_eq!(keys(&found), ["A"]);
    assert_eq!(found.gap, None);
    assert_eq!(api.calls(), 1);
  }

  #[test]
  fn a_page_that_promises_more_without_a_token_is_reported() {
    let (result, _) = search(vec![Ok(json!({ "issues": [{ "key": "A" }], "isLast": false }))], 100);
    let found = result.unwrap();
    assert_eq!(keys(&found), ["A"]);
    assert!(matches!(found.gap, Some(SearchGap::Stopped(_))));
  }

  #[test]
  fn a_repeated_page_token_ends_the_search_instead_of_looping() {
    let (result, api) = search(vec![issues_page(&["A"], Some("same"))], 100);
    let found = result.unwrap();
    assert_eq!(keys(&found), ["A"]);
    assert_eq!(found.gap, Some(SearchGap::Stopped("Jira repeated a page of tickets.".to_string())));
    assert_eq!(api.calls(), 2);
  }

  #[test]
  fn a_ticket_listed_on_two_pages_counts_once() {
    let (result, _) = search(vec![issues_page(&["A", "B"], Some("t1")), issues_page(&["B", "C"], None)], 100);
    assert_eq!(keys(&result.unwrap()), ["A", "B", "C"]);
  }

  #[test]
  fn the_limit_is_only_reported_when_more_tickets_exist() {
    let exact = search(vec![issues_page(&["A", "B", "C"], None)], 3).0.unwrap();
    assert_eq!(exact.issues.len(), 3);
    assert_eq!(exact.gap, None);
    let over = search(vec![issues_page(&["A", "B", "C", "D"], None)], 3).0.unwrap();
    assert_eq!(over.issues.len(), 3);
    assert_eq!(over.gap, Some(SearchGap::Limit));
  }

  #[test]
  fn a_later_page_failing_keeps_the_tickets_already_read() {
    let found = search(vec![issues_page(&["A"], Some("t1")), Err(fatal())], 100).0.unwrap();
    assert_eq!(keys(&found), ["A"]);
    assert_eq!(found.gap, Some(SearchGap::Stopped("no".to_string())));
  }

  #[test]
  fn the_first_page_failing_fails_the_search() {
    assert_eq!(search(vec![Err(fatal())], 100).0.err(), Some(fatal()));
  }

  #[test]
  fn cancelling_fails_the_search_even_after_the_first_page() {
    let result = search(vec![issues_page(&["A"], Some("t1")), Err(Failure::Cancelled)], 100).0;
    assert_eq!(result.err(), Some(Failure::Cancelled));
  }

  #[test]
  fn a_search_that_never_ends_stops_at_the_page_cap() {
    let jira = Retrying::new(FakeJira::new(tickets("TRK", MAX_SEARCH_PAGES + 50, ME, "2026-03-03")).search_page(1), ManualClock::default(), CancelToken::default());
    let found = search_all(&jira, &CancelToken::default(), "/rest/api/3/search/jql?jql=x", ISSUE_LIMIT).unwrap();
    assert_eq!(found.issues.len(), MAX_SEARCH_PAGES);
    assert_eq!(found.gap, Some(SearchGap::Stopped("Jira has more pages of tickets than Trackline will read.".to_string())));
  }

  fn logs_page(ids: &[&str], total: Option<u64>) -> Result<Value, Failure> {
    let worklogs: Vec<Value> = ids.iter().map(|id| json!({ "id": id })).collect();
    Ok(match total {
      Some(total) => json!({ "worklogs": worklogs, "total": total }),
      None => json!({ "worklogs": worklogs }),
    })
  }

  fn read(script: Vec<Result<Value, Failure>>) -> (Result<IssueRead<String>, Failure>, Scripted) {
    let api = Scripted::new(script);
    (read_worklogs(&api, &CancelToken::default(), "TRK-1", (10, 20), |log| log["id"].as_str().map(str::to_owned)), api)
  }

  #[test]
  fn worklog_pages_advance_by_what_jira_returned() {
    let (result, api) = read(vec![logs_page(&["1", "2", "3"], Some(7)), logs_page(&["4", "5"], Some(7)), logs_page(&["6", "7"], Some(7))]);
    let read = result.unwrap();
    assert_eq!(read.items, ["1", "2", "3", "4", "5", "6", "7"]);
    assert!(read.stopped.is_none());
    assert_eq!(api.paths(), [0, 3, 5].map(|start| format!("/rest/api/3/issue/TRK-1/worklog?startAt={start}&maxResults=5000&startedAfter=10&startedBefore=20")));
  }

  #[test]
  fn worklogs_without_a_total_are_read_until_a_page_comes_back_empty() {
    let (result, api) = read(vec![logs_page(&["1", "2"], None), logs_page(&[], None)]);
    assert_eq!(result.unwrap().items, ["1", "2"]);
    assert_eq!(api.calls(), 2);
  }

  #[test]
  fn a_worklog_repeated_between_pages_counts_once() {
    let (result, _) = read(vec![logs_page(&["1", "2"], Some(4)), logs_page(&["2", "3"], Some(4))]);
    let read = result.unwrap();
    assert_eq!(read.items, ["1", "2", "3"]);
    assert!(read.stopped.is_none());
  }

  #[test]
  fn a_page_that_only_repeats_earlier_worklogs_is_reported() {
    let (result, api) = read(vec![logs_page(&["1", "2"], Some(100))]);
    let read = result.unwrap();
    assert_eq!(read.items, ["1", "2"]);
    assert_eq!(read.stopped, Some(Failure::Fatal("Jira repeated a page of worklogs.".to_string())));
    assert_eq!(api.calls(), 2);
  }

  #[test]
  fn a_later_worklog_page_failing_keeps_the_earlier_pages() {
    let (result, _) = read(vec![logs_page(&["1", "2"], Some(5)), Err(fatal())]);
    let read = result.unwrap();
    assert_eq!(read.items, ["1", "2"]);
    assert_eq!(read.stopped, Some(fatal()));
  }

  #[test]
  fn the_first_worklog_page_failing_is_an_error() {
    assert_eq!(read(vec![Err(fatal())]).0.err(), Some(fatal()));
  }

  #[test]
  fn a_ticket_with_endless_worklog_pages_stops_at_the_page_cap() {
    let entries = (0..MAX_WORKLOG_PAGES + 10).map(|n| crate::testing::Entry::new(&format!("w{n}"), ME, "2026-03-03", 5)).collect();
    let jira = Retrying::new(FakeJira::new(vec![crate::testing::Ticket::new("TRK-1", entries)]).worklog_page(1), ManualClock::default(), CancelToken::default());
    let read = read_worklogs(&jira, &CancelToken::default(), "TRK-1", (0, 1), |log| log["id"].as_str().map(str::to_owned)).unwrap();
    assert_eq!(read.items.len(), MAX_WORKLOG_PAGES);
    assert_eq!(read.stopped, Some(Failure::Fatal("This ticket has more worklogs than Trackline will read.".to_string())));
  }
}
