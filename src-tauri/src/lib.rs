use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

const KEYCHAIN_SERVICE: &str = "com.trackline.timesheet.jira";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraWorklog { id: String, date: String, started_at: String, issue: String, summary: String, duration_minutes: u64, description: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraConnection { connected: bool, display_name: Option<String>, site_name: Option<String> }

const CREDENTIALS_ACCOUNT: &str = "credentials";
const LEGACY_ACCOUNTS: [&str; 5] = ["site-url", "email", "api-token", "account-id", "display-name"];
const NOT_CONNECTED: &str = "Connect Jira from Settings before loading worklogs.";

type CredentialStore = BTreeMap<String, String>;
static CREDENTIALS: std::sync::Mutex<Option<CredentialStore>> = std::sync::Mutex::new(None);

fn keychain(account: &str) -> Result<keyring::Entry, String> { keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|_| "Trackline could not access the system keychain.".to_string()) }

fn dev_credentials_path() -> Result<PathBuf, String> {
  if let Ok(path) = std::env::var("TRACKLINE_DEV_STORAGE_PATH") { return Ok(PathBuf::from(path)); }
  Ok(std::env::current_dir().map_err(|_| "Trackline could not resolve its development folder.".to_string())?.join(".trackline-dev.json"))
}

/// Reads all credentials in one go: a single keychain item in release builds (one prompt at most),
/// or the git-ignored JSON file in development builds.
fn read_store() -> Result<CredentialStore, String> {
  if cfg!(debug_assertions) {
    return match fs::read_to_string(dev_credentials_path()?) {
      Ok(content) => serde_json::from_str(&content).map_err(|_| "Trackline development credentials are unreadable. Reconnect from Settings.".to_string()),
      Err(_) => Ok(CredentialStore::new()),
    };
  }
  match keychain(CREDENTIALS_ACCOUNT)?.get_password() {
    Ok(content) => serde_json::from_str(&content).map_err(|_| "Trackline's saved credentials are unreadable. Reconnect from Settings.".to_string()),
    Err(keyring::Error::NoEntry) => migrate_legacy_items(),
    Err(_) => Err("Trackline could not read your Jira credentials from the keychain. Allow access when asked, then try again.".to_string()),
  }
}

/// Earlier versions stored each value as its own keychain item. Copy them into the single item once.
/// The old items are left in place: deleting them could ask for keychain access a second time.
fn migrate_legacy_items() -> Result<CredentialStore, String> {
  let mut store = CredentialStore::new();
  for account in LEGACY_ACCOUNTS {
    if let Ok(entry) = keychain(account) { if let Ok(value) = entry.get_password() { store.insert(account.to_owned(), value); } }
  }
  if !store.is_empty() { write_store(&store)?; }
  Ok(store)
}

fn write_store(store: &CredentialStore) -> Result<(), String> {
  let content = serde_json::to_string(store).map_err(|_| "Trackline could not prepare your credentials.".to_string())?;
  if cfg!(debug_assertions) {
    let path = dev_credentials_path()?;
    fs::write(&path, content).map_err(|_| "Trackline could not save development credentials.".to_string())?;
    #[cfg(unix)] { fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|_| "Trackline could not protect development credentials.".to_string())?; }
    return Ok(());
  }
  keychain(CREDENTIALS_ACCOUNT)?.set_password(&content).map_err(|_| "Trackline could not save credentials in the system keychain.".to_string())
}

/// Returns the credentials, reading storage only the first time in each app session.
fn credentials() -> Result<CredentialStore, String> {
  let mut cache = CREDENTIALS.lock().map_err(|_| "Trackline could not read its credentials.".to_string())?;
  if let Some(store) = cache.as_ref() { return Ok(store.clone()); }
  let store = read_store()?;
  *cache = Some(store.clone());
  Ok(store)
}

fn save_credentials(values: &[(&str, &str)]) -> Result<(), String> {
  let mut store = credentials().unwrap_or_default();
  for (account, value) in values { store.insert((*account).to_owned(), (*value).to_owned()); }
  write_store(&store)?;
  *CREDENTIALS.lock().map_err(|_| "Trackline could not update its credentials.".to_string())? = Some(store);
  Ok(())
}

fn get_secret(account: &str) -> Result<String, String> {
  credentials()?.get(account).cloned().ok_or_else(|| NOT_CONNECTED.to_string())
}

fn normalized_site(site: &str) -> Result<String, String> {
  let url = url::Url::parse(site.trim()).map_err(|_| "Enter a complete Jira site URL, for example https://your-team.atlassian.net.".to_string())?;
  if url.scheme() != "https" || url.host_str().is_none() { return Err("Trackline only connects to HTTPS Jira Cloud URLs.".to_string()); }
  Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn jira_send(request: reqwest::blocking::RequestBuilder, email: &str, token: &str) -> Result<Value, String> {
  let (client, request) = request.build_split();
  let mut request = request.map_err(|_| "Trackline could not prepare the Jira request.".to_string())?;
  // Credentials are only ever sent over HTTPS, whatever address is stored.
  if request.url().scheme() != "https" { return Err("Trackline only sends your Jira credentials over HTTPS. Reconnect with an https:// site address in Settings.".to_string()); }
  let credentials = STANDARD.encode(format!("{email}:{token}"));
  let authorization = reqwest::header::HeaderValue::from_str(&format!("Basic {credentials}")).map_err(|_| "Your Jira credentials contain characters that can't be sent.".to_string())?;
  request.headers_mut().insert(reqwest::header::AUTHORIZATION, authorization);
  let response = client.execute(request)
    .map_err(|_| "Trackline could not reach Jira Cloud.".to_string())?;
  let status = response.status();
  if status == reqwest::StatusCode::UNAUTHORIZED { return Err("Jira rejected the site URL, email address, or API token.".to_string()); }
  if !status.is_success() {
    let body = response.json::<Value>().unwrap_or(Value::Null);
    let detail = body["errorMessages"].as_array().and_then(|messages| messages.first()).and_then(Value::as_str)
      .or_else(|| body["errors"].as_object().and_then(|errors| errors.values().next()).and_then(Value::as_str));
    return Err(match (detail, status) {
      (Some(detail), _) => format!("Jira: {detail}"),
      (None, reqwest::StatusCode::FORBIDDEN) => "Jira denied this action. Check your permissions for this issue.".to_string(),
      (None, _) => format!("Jira could not complete the request ({}).", status.as_u16()),
    });
  }
  let text = response.text().map_err(|_| "Jira returned an unreadable response.".to_string())?;
  if text.trim().is_empty() { return Ok(Value::Null); }
  serde_json::from_str(&text).map_err(|_| "Jira returned an unreadable response.".to_string())
}

fn jira_get(url: &str, email: &str, token: &str) -> Result<Value, String> {
  jira_send(reqwest::blocking::Client::new().get(url), email, token)
}

fn jira_post(url: &str, email: &str, token: &str, body: &Value) -> Result<Value, String> {
  jira_send(reqwest::blocking::Client::new().post(url).json(body), email, token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraIssue { key: String, summary: String, status: Option<String>, updated: Option<String>, issue_type: Option<String>, issue_type_icon: Option<String> }

fn search_jql(jql: &str, limit: u32) -> Result<Vec<JiraIssue>, String> {
  let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
  let encoded = url::form_urlencoded::byte_serialize(jql.as_bytes()).collect::<String>();
  let result = jira_get(&format!("{site}/rest/api/3/search/jql?jql={encoded}&fields=summary,status,updated,issuetype&maxResults={limit}"), &email, &token)?;
  Ok(result["issues"].as_array().into_iter().flatten().map(|issue| JiraIssue {
    key: issue["key"].as_str().unwrap_or_default().to_owned(),
    summary: issue["fields"]["summary"].as_str().unwrap_or("Untitled Jira work").to_owned(),
    status: issue["fields"]["status"]["name"].as_str().map(str::to_owned),
    updated: issue["fields"]["updated"].as_str().map(str::to_owned),
    issue_type: issue["fields"]["issuetype"]["name"].as_str().map(str::to_owned),
    issue_type_icon: issue["fields"]["issuetype"]["iconUrl"].as_str().map(str::to_owned),
  }).collect())
}

fn is_issue_key(query: &str) -> bool {
  let Some((project, number)) = query.split_once('-') else { return false };
  project.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
    && project.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
}

#[tauri::command]
async fn add_worklog(issue_key: String, started: String, duration_minutes: u64, description: String) -> Result<String, String> {
  in_background(move || {
    if !is_issue_key(&issue_key) { return Err("Choose a valid Jira issue.".to_string()); }
    let body = worklog_body(&started, duration_minutes, &description, false)?;
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    let created = jira_post(&format!("{site}/rest/api/3/issue/{issue_key}/worklog"), &email, &token, &body)?;
    created["id"].as_str().map(str::to_owned).ok_or_else(|| "Jira did not confirm the new worklog.".to_string())
  }).await
}

fn worklog_body(started: &str, duration_minutes: u64, description: &str, clear_empty_comment: bool) -> Result<Value, String> {
  if duration_minutes == 0 { return Err("Enter a duration of at least one minute.".to_string()); }
  let mut body = json!({ "started": started, "timeSpentSeconds": duration_minutes * 60 });
  if !description.trim().is_empty() {
    body["comment"] = json!({ "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": description.trim() }] }] });
  } else if clear_empty_comment {
    body["comment"] = json!({ "type": "doc", "version": 1, "content": [] });
  }
  Ok(body)
}

fn is_worklog_id(value: &str) -> bool { !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) }

#[tauri::command]
async fn update_worklog(issue_key: String, worklog_id: String, started: String, duration_minutes: u64, description: String, clear_comment: bool) -> Result<(), String> {
  in_background(move || {
    if !is_issue_key(&issue_key) || !is_worklog_id(&worklog_id) { return Err("This worklog can't be found in Jira.".to_string()); }
    let body = worklog_body(&started, duration_minutes, &description, clear_comment)?;
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    jira_send(reqwest::blocking::Client::new().put(format!("{site}/rest/api/3/issue/{issue_key}/worklog/{worklog_id}")).json(&body), &email, &token)?;
    Ok(())
  }).await
}

#[tauri::command]
async fn delete_worklog(issue_key: String, worklog_id: String) -> Result<(), String> {
  in_background(move || {
    if !is_issue_key(&issue_key) || !is_worklog_id(&worklog_id) { return Err("This worklog can't be found in Jira.".to_string()); }
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    jira_send(reqwest::blocking::Client::new().delete(format!("{site}/rest/api/3/issue/{issue_key}/worklog/{worklog_id}")), &email, &token)?;
    Ok(())
  }).await
}

#[tauri::command]
async fn list_issues(filter: String) -> Result<Vec<JiraIssue>, String> {
  in_background(move || search_jql(match filter.as_str() {
    "viewed" => "issuekey in issueHistory() ORDER BY lastViewed DESC",
    _ => "assignee = currentUser() OR reporter = currentUser() OR worklogAuthor = currentUser() ORDER BY updated DESC",
  }, 30)).await
}

#[tauri::command]
async fn search_issues(query: String) -> Result<Vec<JiraIssue>, String> {
  in_background(move || {
    let query = query.trim();
    if is_issue_key(query) { return search_jql(&format!("key = \"{}\"", query.to_uppercase()), 1); }
    let terms: Vec<String> = query.split(|c: char| !c.is_alphanumeric()).filter(|term| !term.is_empty()).take(6).map(|term| format!("text ~ \"{term}*\"")).collect();
    if terms.is_empty() { return Ok(Vec::new()); }
    search_jql(&format!("{} ORDER BY updated DESC", terms.join(" AND ")), 20)
  }).await
}

#[allow(clippy::too_many_arguments)]
fn worklogs_for_issue(site: String, email: String, token: String, account_id: String, key: String, summary: String, start_date: String, end_date: String, started_after: i64, started_before: i64) -> Result<Vec<JiraWorklog>, String> {
  let logs = jira_get(&format!("{site}/rest/api/3/issue/{key}/worklog?maxResults=5000&startedAfter={started_after}&startedBefore={started_before}"), &email, &token)?;
  let mut worklogs = Vec::new();
  for log in logs["worklogs"].as_array().into_iter().flatten() {
    if log["author"]["accountId"].as_str() != Some(account_id.as_str()) { continue; }
    let started = log["started"].as_str().unwrap_or_default(); let date = &started[..started.len().min(10)];
    if date < start_date.as_str() || date >= end_date.as_str() { continue; }
    let description = log["comment"]["content"].as_array().and_then(|c| c.first()).and_then(|p| p["content"].as_array()).and_then(|c| c.first()).and_then(|t| t["text"].as_str()).unwrap_or("").to_owned();
    worklogs.push(JiraWorklog { id: log["id"].as_str().unwrap_or_default().to_owned(), date: date.to_owned(), started_at: started.to_owned(), issue: key.to_owned(), summary: summary.to_owned(), duration_minutes: log["timeSpentSeconds"].as_u64().unwrap_or(0) / 60, description });
  }
  Ok(worklogs)
}

#[tauri::command]
fn open_api_token_page() -> Result<(), String> {
  Command::new("open").arg("https://id.atlassian.com/manage-profile/security/api-tokens").spawn().map_err(|_| "Trackline could not open the Atlassian API-token page.".to_string())?;
  Ok(())
}

async fn in_background<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(task).await.map_err(|_| "Trackline could not finish the Jira request.".to_string())?
}

#[tauri::command]
async fn connect_jira(site_url: String, email: String, api_token: String) -> Result<JiraConnection, String> {
  in_background(move || connect_jira_blocking(site_url, email, api_token)).await
}

fn connect_jira_blocking(site_url: String, email: String, api_token: String) -> Result<JiraConnection, String> {
  if email.trim().is_empty() || api_token.trim().is_empty() { return Err("Enter your Atlassian email address and API token.".to_string()); }
  let site = normalized_site(&site_url)?;
  let me = jira_get(&format!("{site}/rest/api/3/myself"), email.trim(), api_token.trim())?;
  let account_id = me["accountId"].as_str().ok_or_else(|| "Jira did not return your account identity.".to_string())?;
  let display_name = me["displayName"].as_str().unwrap_or("Jira user");
  save_credentials(&[("site-url", site.as_str()), ("email", email.trim()), ("api-token", api_token.trim()), ("account-id", account_id), ("display-name", display_name)])?;
  Ok(JiraConnection { connected: true, display_name: Some(display_name.to_owned()), site_name: Some(site) })
}

#[tauri::command]
async fn jira_connection() -> Result<JiraConnection, String> {
  in_background(|| Ok(JiraConnection { connected: get_secret("api-token").is_ok() && get_secret("site-url").is_ok(), display_name: get_secret("display-name").ok(), site_name: get_secret("site-url").ok() })).await
}

#[tauri::command]
async fn get_week_worklogs(start_date: String, end_date: String, started_after: i64, started_before: i64) -> Result<Vec<JiraWorklog>, String> {
  in_background(move || load_week_worklogs(start_date, end_date, started_after, started_before)).await
}

fn load_week_worklogs(start_date: String, end_date: String, started_after: i64, started_before: i64) -> Result<Vec<JiraWorklog>, String> {
  let site = get_secret("site-url")?; let email = get_secret("email")?; let token = get_secret("api-token")?; let account_id = get_secret("account-id")?;
  let jql = url::form_urlencoded::byte_serialize(format!("worklogAuthor = currentUser() AND worklogDate >= \"{start_date}\" AND worklogDate < \"{end_date}\"").as_bytes()).collect::<String>();
  let issues = jira_get(&format!("{site}/rest/api/3/search/jql?jql={jql}&fields=summary&maxResults=100"), &email, &token)?;
  let issue_details: Vec<(String, String)> = issues["issues"].as_array().into_iter().flatten().map(|issue| (
    issue["key"].as_str().unwrap_or_default().to_owned(), issue["fields"]["summary"].as_str().unwrap_or("Untitled Jira work").to_owned()
  )).collect();
  let mut worklogs = Vec::new();
  for batch in issue_details.chunks(8) {
    let mut handles = Vec::new();
    for (key, summary) in batch {
      handles.push(std::thread::spawn({
        let (site, email, token, account_id, start_date, end_date, key, summary) = (site.clone(), email.clone(), token.clone(), account_id.clone(), start_date.clone(), end_date.clone(), key.clone(), summary.clone());
        move || worklogs_for_issue(site, email, token, account_id, key, summary, start_date, end_date, started_after, started_before)
      }));
    }
    for handle in handles {
      worklogs.extend(handle.join().map_err(|_| "Trackline could not load Jira worklogs.".to_string())??);
    }
  }
  worklogs.sort_by(|a, b| a.started_at.cmp(&b.started_at)); Ok(worklogs)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraProject { key: String, name: String, avatar_url: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraUser { account_id: String, display_name: String, avatar_url: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamWorklog { id: String, date: String, started_at: String, issue: String, summary: String, duration_minutes: u64, description: String, author_id: String, author_name: String, author_avatar: Option<String> }

fn encode(value: &str) -> String { url::form_urlencoded::byte_serialize(value.as_bytes()).collect() }
fn is_project_key(value: &str) -> bool { value.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && value.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') }
fn is_account_id(value: &str) -> bool { !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-' || c == '_') }
fn comment_text(comment: &Value) -> String {
  comment["content"].as_array().and_then(|c| c.first()).and_then(|p| p["content"].as_array()).and_then(|c| c.first()).and_then(|t| t["text"].as_str()).unwrap_or("").to_owned()
}

#[tauri::command]
async fn search_projects(query: String) -> Result<Vec<JiraProject>, String> {
  in_background(move || {
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    let result = jira_get(&format!("{site}/rest/api/3/project/search?query={}&maxResults=20&orderBy=name", encode(query.trim())), &email, &token)?;
    Ok(result["values"].as_array().into_iter().flatten().map(|project| JiraProject {
      key: project["key"].as_str().unwrap_or_default().to_owned(),
      name: project["name"].as_str().unwrap_or_default().to_owned(),
      avatar_url: project["avatarUrls"]["24x24"].as_str().map(str::to_owned),
    }).collect())
  }).await
}

#[tauri::command]
async fn search_users(query: String) -> Result<Vec<JiraUser>, String> {
  in_background(move || {
    if query.trim().len() < 2 { return Ok(Vec::new()); }
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    let result = jira_get(&format!("{site}/rest/api/3/user/search?query={}&maxResults=20", encode(query.trim())), &email, &token)?;
    Ok(result.as_array().into_iter().flatten()
      .filter(|user| user["accountType"].as_str() == Some("atlassian") && user["active"].as_bool().unwrap_or(false))
      .map(|user| JiraUser {
        account_id: user["accountId"].as_str().unwrap_or_default().to_owned(),
        display_name: user["displayName"].as_str().unwrap_or("Jira user").to_owned(),
        avatar_url: user["avatarUrls"]["24x24"].as_str().map(str::to_owned),
      }).collect())
  }).await
}

#[allow(clippy::too_many_arguments)]
fn team_worklogs_for_issue(site: &str, email: &str, token: &str, key: &str, summary: &str, in_scope_project: bool, account_ids: &[String], start_date: &str, end_date: &str, started_after: i64, started_before: i64) -> Result<Vec<TeamWorklog>, String> {
  let logs = jira_get(&format!("{site}/rest/api/3/issue/{key}/worklog?maxResults=5000&startedAfter={started_after}&startedBefore={started_before}"), email, token)?;
  Ok(logs["worklogs"].as_array().into_iter().flatten().filter_map(|log| {
    let author_id = log["author"]["accountId"].as_str()?;
    if !in_scope_project && !account_ids.iter().any(|id| id == author_id) { return None; }
    let started = log["started"].as_str().unwrap_or_default();
    let date = &started[..started.len().min(10)];
    if date < start_date || date >= end_date { return None; }
    Some(TeamWorklog {
      id: log["id"].as_str().unwrap_or_default().to_owned(), date: date.to_owned(), started_at: started.to_owned(),
      issue: key.to_owned(), summary: summary.to_owned(), duration_minutes: log["timeSpentSeconds"].as_u64().unwrap_or(0) / 60,
      description: comment_text(&log["comment"]), author_id: author_id.to_owned(),
      author_name: log["author"]["displayName"].as_str().unwrap_or("Jira user").to_owned(),
      author_avatar: log["author"]["avatarUrls"]["24x24"].as_str().map(str::to_owned),
    })
  }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamIssue {
  key: String, summary: String, project: String, issue_type: Option<String>, issue_type_icon: Option<String>,
  status: Option<String>, status_category: Option<String>, parent_key: Option<String>, parent_summary: Option<String>,
  original_estimate_seconds: Option<u64>, time_spent_seconds: Option<u64>, work_type: Option<String>, cost_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamData { worklogs: Vec<TeamWorklog>, issues: Vec<TeamIssue> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraField { id: String, name: String, field_type: String }

fn is_custom_field(value: &str) -> bool { value.strip_prefix("customfield_").is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())) }

fn field_text(value: &Value) -> Option<String> {
  match value {
    Value::Null => None,
    Value::String(text) => Some(text.clone()).filter(|text| !text.is_empty()),
    Value::Number(number) => Some(number.to_string()),
    Value::Array(items) => { let parts: Vec<String> = items.iter().filter_map(field_text).collect(); (!parts.is_empty()).then(|| parts.join(", ")) }
    Value::Object(_) => value["value"].as_str().or(value["name"].as_str()).or(value["displayName"].as_str()).map(str::to_owned),
    Value::Bool(flag) => Some(if *flag { "Yes" } else { "No" }.to_owned()),
  }
}

#[tauri::command]
async fn list_custom_fields() -> Result<Vec<JiraField>, String> {
  in_background(|| {
    let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
    let fields = jira_get(&format!("{site}/rest/api/3/field"), &email, &token)?;
    let mut custom: Vec<JiraField> = fields.as_array().into_iter().flatten()
      .filter(|field| field["custom"].as_bool().unwrap_or(false))
      .map(|field| JiraField {
        id: field["id"].as_str().unwrap_or_default().to_owned(),
        name: field["name"].as_str().unwrap_or_default().to_owned(),
        field_type: field["schema"]["type"].as_str().unwrap_or("unknown").to_owned(),
      }).collect();
    custom.sort_by_key(|field| field.name.to_lowercase());
    Ok(custom)
  }).await
}

#[allow(clippy::too_many_arguments)]
fn load_team_worklogs(project_keys: Vec<String>, account_ids: Vec<String>, start_date: String, end_date: String, started_after: i64, started_before: i64, work_type_field: Option<String>, cost_field: Option<String>) -> Result<TeamData, String> {
  if project_keys.iter().any(|key| !is_project_key(key)) || account_ids.iter().any(|id| !is_account_id(id)) { return Err("The team scope contains an invalid project or person.".to_string()); }
  let work_type_field = work_type_field.filter(|id| is_custom_field(id));
  let cost_field = cost_field.filter(|id| is_custom_field(id));
  if project_keys.is_empty() && account_ids.is_empty() { return Ok(TeamData { worklogs: Vec::new(), issues: Vec::new() }); }
  let (site, email, token) = (get_secret("site-url")?, get_secret("email")?, get_secret("api-token")?);
  let mut scope = Vec::new();
  if !project_keys.is_empty() { scope.push(format!("project in ({})", project_keys.join(", "))); }
  if !account_ids.is_empty() { scope.push(format!("worklogAuthor in ({})", account_ids.iter().map(|id| format!("\"{id}\"")).collect::<Vec<_>>().join(", "))); }
  let jql = encode(&format!("({}) AND worklogDate >= \"{start_date}\" AND worklogDate < \"{end_date}\"", scope.join(" OR ")));
  let mut requested_fields = vec!["summary", "project", "issuetype", "status", "parent", "timeoriginalestimate", "timespent"];
  if let Some(id) = &work_type_field { requested_fields.push(id); }
  if let Some(id) = &cost_field { requested_fields.push(id); }
  let requested_fields = requested_fields.join(",");
  let mut issues: Vec<(String, String, bool)> = Vec::new();
  let mut details: Vec<TeamIssue> = Vec::new();
  let mut page_token: Option<String> = None;
  loop {
    let page_query = page_token.as_deref().map(|value| format!("&nextPageToken={}", encode(value))).unwrap_or_default();
    let page = jira_get(&format!("{site}/rest/api/3/search/jql?jql={jql}&fields={requested_fields}&maxResults=100{page_query}"), &email, &token)?;
    for issue in page["issues"].as_array().into_iter().flatten() {
      let fields = &issue["fields"];
      let key = issue["key"].as_str().unwrap_or_default().to_owned();
      let summary = fields["summary"].as_str().unwrap_or("Untitled Jira work").to_owned();
      let project = fields["project"]["key"].as_str().unwrap_or_default().to_owned();
      issues.push((key.clone(), summary.clone(), project_keys.contains(&project)));
      details.push(TeamIssue {
        key, summary, project,
        issue_type: fields["issuetype"]["name"].as_str().map(str::to_owned),
        issue_type_icon: fields["issuetype"]["iconUrl"].as_str().map(str::to_owned),
        status: fields["status"]["name"].as_str().map(str::to_owned),
        status_category: fields["status"]["statusCategory"]["key"].as_str().map(str::to_owned),
        parent_key: fields["parent"]["key"].as_str().map(str::to_owned),
        parent_summary: fields["parent"]["fields"]["summary"].as_str().map(str::to_owned),
        original_estimate_seconds: fields["timeoriginalestimate"].as_u64(),
        time_spent_seconds: fields["timespent"].as_u64(),
        work_type: work_type_field.as_ref().and_then(|id| field_text(&fields[id.as_str()])),
        cost_type: cost_field.as_ref().and_then(|id| field_text(&fields[id.as_str()])),
      });
    }
    page_token = page["nextPageToken"].as_str().map(str::to_owned);
    if page["isLast"].as_bool().unwrap_or(true) || page_token.is_none() || issues.len() >= 2000 { break; }
  }
  let mut worklogs = Vec::new();
  for batch in issues.chunks(8) {
    let handles: Vec<_> = batch.iter().cloned().map(|(key, summary, in_scope_project)| {
      let (site, email, token, account_ids, start_date, end_date) = (site.clone(), email.clone(), token.clone(), account_ids.clone(), start_date.clone(), end_date.clone());
      std::thread::spawn(move || team_worklogs_for_issue(&site, &email, &token, &key, &summary, in_scope_project, &account_ids, &start_date, &end_date, started_after, started_before))
    }).collect();
    for handle in handles { worklogs.extend(handle.join().map_err(|_| "Trackline could not load team worklogs.".to_string())??); }
  }
  worklogs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
  details.retain(|issue| worklogs.iter().any(|log| log.issue == issue.key));
  Ok(TeamData { worklogs, issues: details })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn get_team_worklogs(project_keys: Vec<String>, account_ids: Vec<String>, start_date: String, end_date: String, started_after: i64, started_before: i64, work_type_field: Option<String>, cost_field: Option<String>) -> Result<TeamData, String> {
  in_background(move || load_team_worklogs(project_keys, account_ids, start_date, end_date, started_after, started_before, work_type_field, cost_field)).await
}

#[tauri::command]
async fn save_csv(file_name: String, content: String) -> Result<String, String> {
  in_background(move || {
    let stem: String = file_name.trim_end_matches(".csv").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "Trackline could not find your Downloads folder.".to_string())?;
    let folder = PathBuf::from(home).join("Downloads");
    fs::create_dir_all(&folder).map_err(|_| "Trackline could not open your Downloads folder.".to_string())?;
    let mut path = folder.join(format!("{stem}.csv"));
    let mut copy = 2;
    while path.exists() { path = folder.join(format!("{stem}-{copy}.csv")); copy += 1; }
    fs::write(&path, content).map_err(|_| "Trackline could not save the CSV file.".to_string())?;
    Ok(path.to_string_lossy().into_owned())
  }).await
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
  let result = if cfg!(target_os = "macos") { Command::new("open").arg("-R").arg(&path).spawn() }
    else if cfg!(target_os = "windows") { Command::new("explorer").arg(format!("/select,{path}")).spawn() }
    else { Command::new("xdg-open").arg(PathBuf::from(&path).parent().unwrap_or(std::path::Path::new("."))).spawn() };
  result.map(|_| ()).map_err(|_| "Trackline could not open the file location.".to_string())
}

#[tauri::command]
async fn open_issue(issue_key: String) -> Result<(), String> {
  in_background(move || {
    if !is_issue_key(&issue_key) { return Err("That is not a valid Jira issue key.".to_string()); }
    let site = get_secret("site-url")?;
    let url = format!("{site}/browse/{issue_key}");
    let result = if cfg!(target_os = "macos") { Command::new("open").arg(&url).spawn() }
      else if cfg!(target_os = "windows") { Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn() }
      else { Command::new("xdg-open").arg(&url).spawn() };
    result.map(|_| ()).map_err(|_| "Trackline could not open the issue in your browser.".to_string())
  }).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() { tauri::Builder::default().plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_process::init()).plugin(tauri_plugin_updater::Builder::new().build()).invoke_handler(tauri::generate_handler![open_api_token_page, connect_jira, jira_connection, get_week_worklogs, list_issues, search_issues, add_worklog, update_worklog, delete_worklog, search_projects, search_users, get_team_worklogs, list_custom_fields, save_csv, reveal_file, open_issue]).run(tauri::generate_context!()).expect("error while running Trackline"); }
