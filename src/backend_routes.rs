// ── ADD THIS TO YOUR RAILWAY BACKEND (ether-backend/src/main.rs) ──
//
// Step 1: Add this near the top with your other use statements:
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use axum::extract::Path;
use axum::response::Html;

// Step 2: Add this struct for storing guest presence (put it with your other structs):
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct GuestPresence {
    token: String,
    name: String,
    has_video: bool,
    joined_at: u64,
}

// Step 3: Add guests to your AppState struct:
// Change this:
//   struct AppState { now_playing: Arc<ArcSwap<NowPlayingData>> }
// To this:
//   struct AppState {
//       now_playing: Arc<ArcSwap<NowPlayingData>>,
//       guests: Arc<Mutex<HashMap<String, GuestPresence>>>,
//   }

// Step 4: Add these three handler functions anywhere in the file:

async fn serve_guest_join() -> Html<&'static str> {
    Html(include_str!("../public/guest-join.html"))
}

async fn guest_join_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let token = body["token"].as_str().unwrap_or("").to_string();
    let name  = body["name"].as_str().unwrap_or("Guest").to_string();
    let has_video = body["hasVideo"].as_bool().unwrap_or(false);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();

    state.guests.lock().unwrap().insert(token.clone(), GuestPresence {
        token, name, has_video, joined_at: ts,
    });
    axum::Json(serde_json::json!({ "ok": true }))
}

async fn guest_leave_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let token = body["token"].as_str().unwrap_or("");
    state.guests.lock().unwrap().remove(token);
    axum::Json(serde_json::json!({ "ok": true }))
}

async fn guest_status_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(token): Path<String>,
) -> axum::Json<serde_json::Value> {
    let guests = state.guests.lock().unwrap();
    match guests.get(&token) {
        Some(g) => axum::Json(serde_json::json!({
            "connected": true,
            "name": g.name,
            "hasVideo": g.has_video,
        })),
        None => axum::Json(serde_json::json!({ "connected": false })),
    }
}

// Step 5: Add these routes inside your Router::new() chain:
//
//   .route("/join/:token",          get(serve_guest_join))
//   .route("/guest/join",           post(guest_join_handler))
//   .route("/guest/leave",          post(guest_leave_handler))
//   .route("/guest/status/:token",  get(guest_status_handler))
