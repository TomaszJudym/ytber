// Cloudflare Worker (Rust / workers-rs): ingest endpoint + daily Telegram report.
//
// KV `TRACKER_KV` stores per-day totals keyed "YYYY-MM-DD" -> seconds (as text).
// Secrets: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, INGEST_SECRET.

use serde::{Deserialize, Serialize};
use worker::*;

const MAX_SECONDS: i64 = 86_400;

#[derive(Deserialize)]
struct Ingest {
    date: String,
    seconds: i64,
    #[serde(default)]
    report_now: bool,
}

#[derive(Serialize)]
struct IngestResp {
    total: i64,
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    if req.method() == Method::Post && req.path() == "/ingest" {
        return ingest(&mut req, &env).await;
    }
    Response::error("Not Found", 404)
}

async fn ingest(req: &mut Request, env: &Env) -> Result<Response> {
    // 1. Auth.
    let expected = env.secret("INGEST_SECRET")?.to_string();
    let provided = req
        .headers()
        .get("X-Ingest-Secret")
        .ok()
        .flatten()
        .unwrap_or_default();
    if provided != expected {
        return Response::error("Unauthorized", 401);
    }

    // 2. Parse + validate.
    let body: Ingest = match req.json().await {
        Ok(b) => b,
        Err(_) => return Response::error("Bad Request: invalid JSON", 400),
    };
    if !valid_date(&body.date) {
        return Response::error("Bad Request: date must be YYYY-MM-DD", 400);
    }
    if body.seconds < 0 || body.seconds > MAX_SECONDS {
        return Response::error("Bad Request: seconds out of range", 400);
    }

    // 3. Accumulate in KV.
    let kv = env.kv("TRACKER_KV")?;
    let prev = kv
        .get(&body.date)
        .text()
        .await?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let total = prev + body.seconds;
    kv.put(&body.date, total.to_string())?.execute().await?;

    // 4. Optional immediate (partial) report — key is NOT deleted.
    if body.report_now {
        let (h, m) = hm(total);
        let text = format!("YouTube {} (partial): {}h {}m", body.date, h, m);
        if let Err(e) = send_telegram(env, &text).await {
            console_error!("telegram partial report failed: {:?}", e);
        }
    }

    // 5. Respond.
    Response::from_json(&IngestResp { total })
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    console_error_panic_hook::set_once();
    if let Err(e) = run_cron(&env).await {
        console_error!("cron failed: {:?}", e);
    }
}

async fn run_cron(env: &Env) -> Result<()> {
    // 1. Dates in UTC. ASSUMPTION: report boundary is UTC midnight, not local.
    let now_ms = Date::now().as_millis() as i64;
    let today_days = now_ms / 86_400_000;
    let today = fmt_date(today_days);
    let yesterday = fmt_date(today_days - 1);

    let kv = env.kv("TRACKER_KV")?;

    // 2. Report yesterday.
    let value = kv.get(&yesterday).text().await?;
    let text = match value.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        Some(secs) => {
            let (h, m) = hm(secs);
            format!("YouTube {}: {}h {}m", yesterday, h, m)
        }
        None => format!("YouTube {}: 0m", yesterday),
    };
    // On Telegram failure: log and keep the key (retry next cron); do not delete below.
    let report_ok = match send_telegram(env, &text).await {
        Ok(()) => {
            console_log!("reported {}", yesterday);
            true
        }
        Err(e) => {
            console_error!("telegram daily report failed for {}: {:?}", yesterday, e);
            false
        }
    };

    // 3. Delete all stale keys (date < today). Keys are "YYYY-MM-DD" so lexical
    //    order == chronological order.
    let mut cursor: Option<String> = None;
    let mut deleted = 0u32;
    loop {
        let mut list = kv.list();
        if let Some(c) = &cursor {
            list = list.cursor(c.clone());
        }
        let res = list.execute().await?;
        for key in &res.keys {
            if key.name.as_str() < today.as_str() {
                // Preserve yesterday's key if its report failed, so it retries.
                if key.name == yesterday && !report_ok {
                    continue;
                }
                kv.delete(&key.name).await?;
                deleted += 1;
            }
        }
        match res.cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    console_log!("cron done: deleted {} stale key(s)", deleted);
    Ok(())
}

async fn send_telegram(env: &Env, text: &str) -> Result<()> {
    let token = env.secret("TELEGRAM_TOKEN")?.to_string();
    let chat_id = env.secret("TELEGRAM_CHAT_ID")?.to_string();
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);

    // text contains only [A-Za-z0-9 :()h m-] and digits -> JSON-safe without escaping.
    let body = format!(
        "{{\"chat_id\":\"{}\",\"text\":\"{}\"}}",
        chat_id,
        json_escape(text)
    );

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.into()));

    let request = Request::new_with_init(&url, &init)?;
    let resp = Fetch::Request(request).send().await?;
    if resp.status_code() != 200 {
        return Err(Error::RustError(format!(
            "telegram HTTP {}",
            resp.status_code()
        )));
    }
    Ok(())
}

// ---- helpers ----

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

fn hm(seconds: i64) -> (i64, i64) {
    (seconds / 3600, (seconds % 3600) / 60)
}

// Minimal escaper for the few chars JSON requires; our text is ASCII-safe but
// this keeps us correct if the format ever changes.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

// Days-since-epoch (UTC) -> "YYYY-MM-DD" via Howard Hinnant's civil_from_days.
fn fmt_date(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", year, m, d)
}
