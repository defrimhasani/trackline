//! The two worklog loads: your own calendar and the Team view.

use crate::{
  comment_text, encode, field_text,
  sync::{self, CancelToken, Failure, JiraRead, SyncStatus, ISSUE_LIMIT},
  JiraWorklog, TeamData, TeamIssue, TeamWorklog, WeekWorklogs,
};
use serde_json::Value;
use std::collections::HashSet;

pub struct WeekQuery { pub account_id: String, pub start_date: String, pub end_date: String, pub started_after: i64, pub started_before: i64 }

pub struct TeamQuery {
  pub project_keys: Vec<String>, pub account_ids: Vec<String>, pub field_ids: Vec<String>,
  pub start_date: String, pub end_date: String, pub started_after: i64, pub started_before: i64,
}

/// The day a worklog started, as `YYYY-MM-DD`.
fn started_day(started: &str) -> &str { started.get(..10).unwrap_or(started) }

fn own_worklog(query: &WeekQuery, key: &str, summary: &str, log: &Value) -> Option<JiraWorklog> {
  if log["author"]["accountId"].as_str() != Some(query.account_id.as_str()) { return None; }
  let started = log["started"].as_str().unwrap_or_default();
  let date = started_day(started);
  if date < query.start_date.as_str() || date >= query.end_date.as_str() { return None; }
  Some(JiraWorklog {
    id: log["id"].as_str().unwrap_or_default().to_owned(), date: date.to_owned(), started_at: started.to_owned(),
    issue: key.to_owned(), summary: summary.to_owned(), duration_minutes: log["timeSpentSeconds"].as_u64().unwrap_or(0) / 60,
    description: comment_text(&log["comment"]),
  })
}

pub fn week(api: &dyn JiraRead, cancel: &CancelToken, query: &WeekQuery) -> Result<WeekWorklogs, Failure> {
  let jql = encode(&format!("worklogAuthor = currentUser() AND worklogDate >= \"{}\" AND worklogDate < \"{}\"", query.start_date, query.end_date));
  let search = sync::search_all(api, cancel, &format!("/rest/api/3/search/jql?jql={jql}&fields=summary"), ISSUE_LIMIT)?;
  let issues: Vec<(String, String)> = search.issues.iter().map(|issue| (
    issue["key"].as_str().unwrap_or_default().to_owned(), issue["fields"]["summary"].as_str().unwrap_or("Untitled Jira work").to_owned(),
  )).collect();
  let (mut worklogs, gaps) = sync::gather(api, cancel, &issues, |(key, _)| key.as_str(), (query.started_after, query.started_before), |(key, summary), log| own_worklog(query, key, summary, log))?;
  worklogs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
  Ok(WeekWorklogs { worklogs, sync: SyncStatus::describe(search.gap.as_ref(), &gaps) })
}

fn team_issue(issue: &Value, field_ids: &[String]) -> TeamIssue {
  let fields = &issue["fields"];
  TeamIssue {
    key: issue["key"].as_str().unwrap_or_default().to_owned(),
    summary: fields["summary"].as_str().unwrap_or("Untitled Jira work").to_owned(),
    project: fields["project"]["key"].as_str().unwrap_or_default().to_owned(),
    issue_type: fields["issuetype"]["name"].as_str().map(str::to_owned),
    issue_type_icon: fields["issuetype"]["iconUrl"].as_str().map(str::to_owned),
    status: fields["status"]["name"].as_str().map(str::to_owned),
    status_category: fields["status"]["statusCategory"]["key"].as_str().map(str::to_owned),
    parent_key: fields["parent"]["key"].as_str().map(str::to_owned),
    parent_summary: fields["parent"]["fields"]["summary"].as_str().map(str::to_owned),
    priority: fields["priority"]["name"].as_str().map(str::to_owned),
    priority_id: fields["priority"]["id"].as_str().map(str::to_owned),
    priority_icon: fields["priority"]["iconUrl"].as_str().map(str::to_owned),
    original_estimate_seconds: fields["timeoriginalestimate"].as_u64(),
    time_spent_seconds: fields["timespent"].as_u64(),
    field_values: field_ids.iter().filter_map(|id| field_text(&fields[id.as_str()]).map(|text| (id.clone(), text))).collect(),
  }
}

fn team_worklog(query: &TeamQuery, issue: &TeamIssue, log: &Value) -> Option<TeamWorklog> {
  let author_id = log["author"]["accountId"].as_str()?;
  if !query.project_keys.contains(&issue.project) && !query.account_ids.iter().any(|id| id == author_id) { return None; }
  let started = log["started"].as_str().unwrap_or_default();
  let date = started_day(started);
  if date < query.start_date.as_str() || date >= query.end_date.as_str() { return None; }
  Some(TeamWorklog {
    id: log["id"].as_str().unwrap_or_default().to_owned(), date: date.to_owned(), started_at: started.to_owned(),
    issue: issue.key.clone(), summary: issue.summary.clone(), duration_minutes: log["timeSpentSeconds"].as_u64().unwrap_or(0) / 60,
    description: comment_text(&log["comment"]), author_id: author_id.to_owned(),
    author_name: log["author"]["displayName"].as_str().unwrap_or("Jira user").to_owned(),
    author_avatar: log["author"]["avatarUrls"]["24x24"].as_str().map(str::to_owned),
  })
}

pub fn team(api: &dyn JiraRead, cancel: &CancelToken, query: &TeamQuery) -> Result<TeamData, Failure> {
  let mut scope = Vec::new();
  if !query.project_keys.is_empty() { scope.push(format!("project in ({})", query.project_keys.join(", "))); }
  if !query.account_ids.is_empty() { scope.push(format!("worklogAuthor in ({})", query.account_ids.iter().map(|id| format!("\"{id}\"")).collect::<Vec<_>>().join(", "))); }
  let jql = encode(&format!("({}) AND worklogDate >= \"{}\" AND worklogDate < \"{}\"", scope.join(" OR "), query.start_date, query.end_date));
  let mut fields = vec!["summary", "project", "issuetype", "status", "parent", "priority", "timeoriginalestimate", "timespent"];
  fields.extend(query.field_ids.iter().map(String::as_str));
  let search = sync::search_all(api, cancel, &format!("/rest/api/3/search/jql?jql={jql}&fields={}", fields.join(",")), ISSUE_LIMIT)?;
  let details: Vec<TeamIssue> = search.issues.iter().map(|issue| team_issue(issue, &query.field_ids)).collect();
  let (mut worklogs, gaps) = sync::gather(api, cancel, &details, |issue| issue.key.as_str(), (query.started_after, query.started_before), |issue, log| team_worklog(query, issue, log))?;
  worklogs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
  let logged: HashSet<&str> = worklogs.iter().map(|log| log.issue.as_str()).collect();
  let issues = details.into_iter().filter(|issue| logged.contains(issue.key.as_str())).collect();
  Ok(TeamData { worklogs, issues, sync: SyncStatus::describe(search.gap.as_ref(), &gaps) })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{
    sync::{locked, Retrying},
    testing::{tickets, Entry, FakeJira, ManualClock, Ticket, COLLEAGUE, ME},
  };
  use std::{sync::Mutex, time::Duration};

  const PAT: &str = "acct-pat";
  const FIRST_PAGE_OF_TOKENS: &str = "nextPageToken=";

  fn stack(fake: FakeJira) -> (Retrying<FakeJira, ManualClock>, CancelToken) {
    let cancel = CancelToken::default();
    (Retrying::new(fake, ManualClock::default(), cancel.clone()), cancel)
  }

  fn week_query() -> WeekQuery {
    WeekQuery { account_id: ME.to_string(), start_date: "2026-03-02".to_string(), end_date: "2026-03-09".to_string(), started_after: 1_772_409_600_000, started_before: 1_773_014_400_000 }
  }

  fn team_query(projects: &[&str], people: &[&str]) -> TeamQuery {
    TeamQuery {
      project_keys: projects.iter().map(ToString::to_string).collect(), account_ids: people.iter().map(ToString::to_string).collect(),
      field_ids: vec!["customfield_10010".to_string()], start_date: "2026-03-02".to_string(), end_date: "2026-03-09".to_string(),
      started_after: 1_772_409_600_000, started_before: 1_773_014_400_000,
    }
  }

  fn minutes(logs: &[JiraWorklog]) -> u64 { logs.iter().map(|log| log.duration_minutes).sum() }
  fn team_minutes(logs: &[TeamWorklog]) -> u64 { logs.iter().map(|log| log.duration_minutes).sum() }
  fn failing(message: &str) -> Failure { Failure::Fatal(message.to_string()) }

  #[test]
  fn a_week_with_nothing_logged_is_complete_and_empty() {
    let (api, cancel) = stack(FakeJira::new(Vec::new()));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert!(loaded.worklogs.is_empty());
    assert_eq!(loaded.sync, SyncStatus::complete());
  }

  #[test]
  fn a_week_with_more_than_a_page_of_tickets_loads_all_of_them() {
    let fixture: Vec<Ticket> = (1..=250).map(|n| Ticket::new(&format!("TRK-{n}"), vec![
      Entry::new(&format!("{n}-mine"), ME, "2026-03-03", 30),
      Entry::new(&format!("{n}-theirs"), COLLEAGUE, "2026-03-03", 45),
    ])).collect();
    let (api, cancel) = stack(FakeJira::new(fixture));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(loaded.worklogs.len(), 250);
    assert_eq!(minutes(&loaded.worklogs), 250 * 30);
    assert_eq!(loaded.sync, SyncStatus::complete());
    assert_eq!(api.transport().count("search/jql"), 3);
    assert_eq!(api.transport().count("/worklog"), 250);
    assert!(api.transport().requests()[0].starts_with(
      "/rest/api/3/search/jql?jql=worklogAuthor+%3D+currentUser%28%29+AND+worklogDate+%3E%3D+%222026-03-02%22+AND+worklogDate+%3C+%222026-03-09%22&fields=summary&maxResults=100"
    ));
  }

  #[test]
  fn every_worklog_page_is_read_and_scoped() {
    let mut expected = 0;
    let entries: Vec<Entry> = (1..=23u64).map(|n| {
      let (author, day) = if n % 3 == 0 { (COLLEAGUE, "2026-03-04") } else if n % 5 == 0 { (ME, "2026-03-09") } else if n % 7 == 0 { (ME, "2026-03-01") } else { (ME, "2026-03-05") };
      if author == ME && day == "2026-03-05" { expected += n * 5; }
      Entry::new(&format!("w{n}"), author, day, n * 5)
    }).collect();
    let (api, cancel) = stack(FakeJira::new(vec![Ticket::new("TRK-1", entries)]).worklog_page(10));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert!(expected > 0);
    assert_eq!(minutes(&loaded.worklogs), expected);
    assert_eq!(loaded.sync, SyncStatus::complete());
    let paths = api.transport().requests();
    assert_eq!(&paths[1..], [0, 10, 20].map(|start| format!("/rest/api/3/issue/TRK-1/worklog?startAt={start}&maxResults=5000&startedAfter=1772409600000&startedBefore=1773014400000")));
  }

  #[test]
  fn a_worklog_repeated_across_pages_is_counted_once() {
    let entries = ["w1", "w2", "w3", "w2", "w4"].iter().map(|id| Entry::new(id, ME, "2026-03-03", 20)).collect();
    let (api, cancel) = stack(FakeJira::new(vec![Ticket::new("TRK-1", entries)]).worklog_page(2));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 4 * 20);
    assert_eq!(loaded.sync, SyncStatus::complete());
  }

  #[test]
  fn worklogs_come_back_in_the_order_they_started() {
    let fixture = vec![
      Ticket::new("TRK-1", vec![Entry::new("a", ME, "2026-03-06", 10), Entry::new("b", ME, "2026-03-03", 10)]),
      Ticket::new("TRK-2", vec![Entry::new("c", ME, "2026-03-04", 10)]),
    ];
    let (api, cancel) = stack(FakeJira::new(fixture));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(loaded.worklogs.iter().map(|log| log.id.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
  }

  #[test]
  fn a_week_keeps_the_text_of_each_worklog() {
    let (api, cancel) = stack(FakeJira::new(vec![Ticket::new("TRK-1", vec![Entry::new("w1", ME, "2026-03-03", 90)])]));
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    let log = &loaded.worklogs[0];
    assert_eq!((log.issue.as_str(), log.summary.as_str(), log.date.as_str(), log.description.as_str()), ("TRK-1", "Summary of TRK-1", "2026-03-03", "Work w1"));
    assert_eq!(log.duration_minutes, 90);
  }

  #[test]
  fn a_rate_limited_ticket_search_is_retried() {
    let limited = Failure::Busy { message: "Rate limited.".to_string(), retry_after: Some(Duration::from_secs(2)) };
    let fake = FakeJira::new(tickets("TRK", 120, ME, "2026-03-03")).fault(move |_, ordinal| (2..=3).contains(&ordinal).then(|| limited.clone()));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 120 * 30);
    assert_eq!(loaded.sync, SyncStatus::complete());
    assert_eq!(api.clock().slept(), [Duration::from_secs(2), Duration::from_secs(2)]);
  }

  #[test]
  fn workers_rate_limited_together_all_recover_with_nothing_missing() {
    let limited = Failure::Busy { message: "Rate limited.".to_string(), retry_after: Some(Duration::from_secs(2)) };
    let refused = Mutex::new(HashSet::new());
    let fake = FakeJira::new(tickets("TRK", 60, ME, "2026-03-03")).fault(move |path, _| (path.contains("/worklog") && locked(&refused).insert(path.to_string())).then(|| limited.clone()));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(loaded.worklogs.len(), 60);
    assert_eq!(minutes(&loaded.worklogs), 60 * 30);
    assert_eq!(loaded.sync, SyncStatus::complete());
    assert_eq!(api.transport().count("/worklog"), 120);
    let waits = api.clock().slept();
    assert_eq!(waits.first(), Some(&Duration::from_secs(2)));
    assert!(waits.iter().all(|wait| *wait <= Duration::from_secs(2)), "a shared pause must not add up: {waits:?}");
  }

  #[test]
  fn nothing_goes_missing_without_being_reported_however_the_rate_limit_lands() {
    let limited = Failure::Busy { message: "Rate limited.".to_string(), retry_after: Some(Duration::from_secs(2)) };
    let fake = FakeJira::new(tickets("TRK", 60, ME, "2026-03-03")).fault(move |_, ordinal| (2..=9).contains(&ordinal).then(|| limited.clone()));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    let present: HashSet<&str> = loaded.worklogs.iter().map(|log| log.issue.as_str()).collect();
    let missing: Vec<String> = (1..=60).map(|n| format!("TRK-{n}")).filter(|key| !present.contains(key.as_str())).collect();
    // A request only gives up after four refusals, so eight refusals can cost at most two tickets.
    assert!(missing.len() <= 2, "{missing:?}");
    assert_eq!(loaded.sync.complete, missing.is_empty());
    for key in &missing {
      assert!(loaded.sync.problems.iter().any(|problem| problem.split([' ', ',']).any(|word| word == key)), "{key} is missing but was not reported: {:?}", loaded.sync.problems);
    }
    assert_eq!(minutes(&loaded.worklogs), (60 - missing.len() as u64) * 30);
  }

  #[test]
  fn a_ticket_that_stays_rate_limited_is_reported_and_the_rest_still_load() {
    let limited = Failure::Busy { message: "Rate limited.".to_string(), retry_after: None };
    let fake = FakeJira::new(tickets("TRK", 6, ME, "2026-03-03")).fault(move |path, _| path.contains("/TRK-4/worklog").then(|| limited.clone()));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 5 * 30);
    assert_eq!(loaded.sync.problems, ["Worklogs for TRK-4 could not be loaded. Rate limited."]);
    assert!(!loaded.sync.complete);
  }

  #[test]
  fn a_later_worklog_page_failing_keeps_what_was_read_and_flags_the_ticket() {
    let long = Ticket::new("TRK-1", (1..=12).map(|n| Entry::new(&format!("a{n}"), ME, "2026-03-03", 10)).collect());
    let short = Ticket::new("TRK-2", vec![Entry::new("b1", ME, "2026-03-04", 25)]);
    let fake = FakeJira::new(vec![long, short]).worklog_page(5).fault(|path, _| path.contains("TRK-1/worklog?startAt=5").then(|| failing("Jira could not complete the request (500).")));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 5 * 10 + 25);
    assert!(!loaded.sync.complete);
    assert_eq!(loaded.sync.problems, ["Worklogs for TRK-1 could not be loaded. Jira could not complete the request (500)."]);
  }

  #[test]
  fn a_ticket_the_user_may_not_read_is_flagged_without_failing_the_load() {
    let denied = "Jira denied this action. Check your permissions for this issue.";
    let fake = FakeJira::new(tickets("TRK", 5, ME, "2026-03-03")).fault(move |path, _| path.contains("/TRK-2/worklog").then(|| failing(denied)));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 4 * 30);
    assert_eq!(loaded.sync.problems, [format!("Worklogs for TRK-2 could not be loaded. {denied}")]);
  }

  #[test]
  fn a_week_fails_when_the_first_page_of_tickets_cannot_be_read() {
    let fake = FakeJira::new(tickets("TRK", 5, ME, "2026-03-03")).fault(|path, _| path.contains("search/jql").then(|| failing("Jira: The JQL query is invalid.")));
    let (api, cancel) = stack(fake);
    assert_eq!(week(&api, &cancel, &week_query()).err(), Some(failing("Jira: The JQL query is invalid.")));
  }

  #[test]
  fn a_later_page_of_tickets_failing_keeps_the_first_pages_and_says_so() {
    let fake = FakeJira::new(tickets("TRK", 250, ME, "2026-03-03")).fault(|path, _| path.contains(FIRST_PAGE_OF_TOKENS).then(|| failing("Jira: boom")));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert_eq!(minutes(&loaded.worklogs), 100 * 30);
    assert!(!loaded.sync.complete);
    assert_eq!(loaded.sync.problems, ["Trackline could not finish listing tickets, so some worklogs may be missing. Jira: boom"]);
  }

  #[test]
  fn cancelling_a_week_midway_stops_the_requests() {
    let cancel = CancelToken::default();
    let fake = FakeJira::new(tickets("TRK", 400, ME, "2026-03-03")).fault({ let cancel = cancel.clone(); move |_, ordinal| { if ordinal == 20 { cancel.cancel(); } None } });
    let api = Retrying::new(fake, ManualClock::default(), cancel.clone());
    assert_eq!(week(&api, &cancel, &week_query()).err(), Some(Failure::Cancelled));
    assert!(api.transport().requests().len() < 40, "{} requests", api.transport().requests().len());
  }

  #[test]
  fn rejected_credentials_midway_stop_the_requests_and_flag_the_rest() {
    let rejected = Failure::Unauthorized("Jira rejected the site URL, email address, or API token.".to_string());
    let fake = FakeJira::new(tickets("TRK", 400, ME, "2026-03-03")).fault(move |_, ordinal| (ordinal >= 12).then(|| rejected.clone()));
    let (api, cancel) = stack(fake);
    let loaded = week(&api, &cancel, &week_query()).unwrap();
    assert!(!loaded.sync.complete);
    assert!(loaded.worklogs.len() < 400);
    assert_eq!(loaded.sync.problems.len(), 1);
    assert!(loaded.sync.problems[0].contains("Jira rejected the site URL, email address, or API token."));
    assert!(api.transport().requests().len() <= 12 + crate::sync::WORKERS, "{} requests", api.transport().requests().len());
  }

  #[test]
  fn a_team_load_past_the_ticket_limit_says_so_and_totals_match_what_was_read() {
    let (api, cancel) = stack(FakeJira::new(tickets("TRK", 2050, COLLEAGUE, "2026-03-03")));
    let loaded = team(&api, &cancel, &team_query(&["TRK"], &[])).unwrap();
    assert_eq!(loaded.worklogs.len(), 2000);
    assert_eq!(loaded.issues.len(), 2000);
    assert_eq!(team_minutes(&loaded.worklogs), 2000 * 30);
    assert!(!loaded.sync.complete);
    assert_eq!(loaded.sync.problems, ["Trackline stopped after 2000 tickets, so some worklogs may be missing. Try a shorter period or narrow the scope."]);
    assert_eq!(api.transport().count("/worklog"), 2000);
  }

  #[test]
  fn a_team_load_of_exactly_the_ticket_limit_is_complete() {
    let (api, cancel) = stack(FakeJira::new(tickets("TRK", 2000, COLLEAGUE, "2026-03-03")));
    let loaded = team(&api, &cancel, &team_query(&["TRK"], &[])).unwrap();
    assert_eq!(team_minutes(&loaded.worklogs), 2000 * 30);
    assert_eq!(loaded.sync, SyncStatus::complete());
  }

  #[test]
  fn a_team_load_keeps_project_work_and_the_selected_peoples_work_elsewhere() {
    let fixture = vec![
      Ticket::new("TRK-1", vec![Entry::new("a", ME, "2026-03-03", 60), Entry::new("b", COLLEAGUE, "2026-03-04", 30), Entry::new("old", ME, "2026-02-27", 999)]),
      Ticket::new("OPS-1", vec![Entry::new("c", PAT, "2026-03-05", 15), Entry::new("d", COLLEAGUE, "2026-03-05", 500)]),
      Ticket::new("OPS-2", vec![Entry::new("e", COLLEAGUE, "2026-03-05", 500)]),
    ];
    let (api, cancel) = stack(FakeJira::new(fixture));
    let loaded = team(&api, &cancel, &team_query(&["TRK"], &[PAT])).unwrap();
    assert_eq!(loaded.worklogs.iter().map(|log| log.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    assert_eq!(team_minutes(&loaded.worklogs), 60 + 30 + 15);
    assert_eq!(loaded.issues.iter().map(|issue| issue.key.as_str()).collect::<Vec<_>>(), ["TRK-1", "OPS-1"]);
    assert_eq!(loaded.sync, SyncStatus::complete());
  }

  #[test]
  fn a_team_load_keeps_the_details_of_each_ticket_and_worklog() {
    let (api, cancel) = stack(FakeJira::new(vec![Ticket::new("TRK-1", vec![Entry::new("a", COLLEAGUE, "2026-03-03", 60)])]));
    let loaded = team(&api, &cancel, &team_query(&["TRK"], &[])).unwrap();
    let issue = &loaded.issues[0];
    assert_eq!((issue.key.as_str(), issue.project.as_str(), issue.summary.as_str()), ("TRK-1", "TRK", "Summary of TRK-1"));
    assert_eq!((issue.issue_type.as_deref(), issue.status.as_deref(), issue.status_category.as_deref()), (Some("Task"), Some("In Progress"), Some("indeterminate")));
    assert_eq!((issue.parent_key.as_deref(), issue.parent_summary.as_deref()), (Some("EPIC-1"), Some("The epic")));
    assert_eq!((issue.priority.as_deref(), issue.priority_id.as_deref(), issue.priority_icon.as_deref()), (Some("High"), Some("2"), Some("https://jira.test/high.svg")));
    assert_eq!((issue.original_estimate_seconds, issue.time_spent_seconds), (Some(7200), Some(3600)));
    assert_eq!(issue.field_values.get("customfield_10010").map(String::as_str), Some("Platform"));
    let log = &loaded.worklogs[0];
    assert_eq!((log.author_id.as_str(), log.author_name.as_str(), log.description.as_str()), (COLLEAGUE, "Person acct-colleague", "Work a"));
    assert_eq!(log.author_avatar.as_deref(), Some("https://jira.test/avatar.png"));
  }

  #[test]
  fn a_team_ticket_that_cannot_be_read_is_flagged_and_left_out() {
    let fake = FakeJira::new(tickets("TRK", 3, COLLEAGUE, "2026-03-03")).fault(|path, _| path.contains("/TRK-2/worklog").then(|| failing("Jira: boom")));
    let (api, cancel) = stack(fake);
    let loaded = team(&api, &cancel, &team_query(&["TRK"], &[])).unwrap();
    assert_eq!(loaded.issues.iter().map(|issue| issue.key.as_str()).collect::<Vec<_>>(), ["TRK-1", "TRK-3"]);
    assert_eq!(team_minutes(&loaded.worklogs), 2 * 30);
    assert_eq!(loaded.sync.problems, ["Worklogs for TRK-2 could not be loaded. Jira: boom"]);
  }

  #[test]
  fn cancelling_a_team_load_midway_stops_the_requests() {
    let cancel = CancelToken::default();
    let fake = FakeJira::new(tickets("TRK", 600, COLLEAGUE, "2026-03-03")).fault({ let cancel = cancel.clone(); move |_, ordinal| { if ordinal == 30 { cancel.cancel(); } None } });
    let api = Retrying::new(fake, ManualClock::default(), cancel.clone());
    assert_eq!(team(&api, &cancel, &team_query(&["TRK"], &[])).err(), Some(Failure::Cancelled));
    assert!(api.transport().requests().len() < 50, "{} requests", api.transport().requests().len());
  }
}
