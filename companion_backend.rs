// Add to ether-backend/src/main.rs
//
// These routes let the companion app (Watch/CarPlay/phone) control Ether.
// Ether polls these commands via a shared state queue.

// Add this to your AppState:
//   pending_cmds: Arc<Mutex<Vec<CompanionCmd>>>

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompanionCmd {
    pub cmd:  String,
    pub data: serde_json::Value,
    pub ts:   u64,
}

// POST /api/cmd — companion sends commands here
async fn companion_cmd_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let cmd = body["cmd"].as_str().unwrap_or("").to_string();
    let ts  = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();

    // Store command — Ether desktop polls /api/pending-cmds and executes them
    if let Ok(mut cmds) = state.pending_cmds.lock() {
        cmds.push(CompanionCmd { cmd, data: body.clone(), ts });
        // Keep only last 20 commands
        if cmds.len() > 20 { cmds.drain(0..cmds.len()-20); }
    }

    axum::Json(serde_json::json!({ "ok": true }))
}

// GET /api/pending-cmds — Ether desktop polls this every second
// Returns and clears the command queue
async fn pending_cmds_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> axum::Json<Vec<CompanionCmd>> {
    let mut cmds = state.pending_cmds.lock().unwrap();
    let out = cmds.clone();
    cmds.clear();
    axum::Json(out)
}

// GET /companion — serve the companion HTML
async fn serve_companion() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("../public/companion.html"))
}

// Add these routes to your Router::new() chain:
// .route("/companion",           get(serve_companion))
// .route("/api/cmd",             post(companion_cmd_handler))
// .route("/api/pending-cmds",    get(pending_cmds_handler))
