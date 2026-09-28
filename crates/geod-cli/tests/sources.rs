use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn temp_home() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("geod-cli-sources-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn cli(home: &PathBuf, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_geod"))
        .env("GEOD_CLI_HOME", home)
        .args(args)
        .output()
        .unwrap()
}

fn result(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "unexpected stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

#[test]
fn registers_selects_and_persists_custom_sources() {
    let home = temp_home();
    let register = cli(
        &home,
        &[
            "sources",
            "register",
            "--id",
            "my_tiles",
            "--name",
            "My licensed tiles",
            "--url",
            "http://127.0.0.1:9999/{z}/{x}/{y}.png",
            "--attribution",
            "My provider",
            "--scheme",
            "tms",
            "--max-zoom",
            "3",
        ],
    );
    assert!(
        register.status.success(),
        "{}",
        String::from_utf8_lossy(&register.stdout)
    );
    assert!(cli(&home, &["sources", "default", "--id", "my_tiles"])
        .status
        .success());
    let list = result(&cli(&home, &["sources", "list"]));
    assert_eq!(list["defaultSourceId"], "my_tiles");
    assert!(list["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "my_tiles" && s["default"] == true));
    assert!(list["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "osm" && s["available"] == false));
    assert!(list["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "nasa_gibs_blue_marble" && s["available"] == true));
    let shown = result(&cli(&home, &["sources", "show", "--id", "my_tiles"]));
    assert_eq!(
        shown["source"]["url"],
        "http://127.0.0.1:9999/{z}/{x}/{-y}.png"
    );
    let request = home.join("job.json");
    fs::write(
        &request,
        serde_json::to_vec(&json!({
            "schemaVersion":"1.0","name":"test","bounds":[-1.0,-1.0,1.0,1.0],
            "imagery":{"zoom":2}
        }))
        .unwrap(),
    )
    .unwrap();
    let plan = cli(&home, &["plan", "--request", request.to_str().unwrap()]);
    assert!(
        plan.status.success(),
        "{}",
        String::from_utf8_lossy(&plan.stdout)
    );
    assert!(cli(
        &home,
        &[
            "plan",
            "--request",
            request.to_str().unwrap(),
            "--source",
            "nasa_gibs_blue_marble"
        ]
    )
    .status
    .success());
    let override_fail = cli(
        &home,
        &[
            "plan",
            "--request",
            request.to_str().unwrap(),
            "--source",
            "missing",
        ],
    );
    assert!(!override_fail.status.success());
    assert!(result(&override_fail)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Unknown imagery source"));
    assert!(cli(&home, &["sources", "remove", "--id", "my_tiles"])
        .status
        .success());
    assert!(result(&cli(&home, &["sources", "list"]))["defaultSourceId"].is_null());
    assert!(
        !cli(&home, &["plan", "--request", request.to_str().unwrap()])
            .status
            .success()
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn quadkey_source_can_be_selected_and_invalid_overlays_fail() {
    let home = temp_home();
    assert!(cli(
        &home,
        &[
            "sources",
            "register",
            "--id",
            "quad",
            "--name",
            "Quad imagery",
            "--url",
            "https://example.test/tiles/{q}.png",
            "--attribution",
            "Example",
        ]
    )
    .status
    .success());
    let request = home.join("quad.json");
    fs::write(
        &request,
        serde_json::to_vec(&json!({
            "schemaVersion":"1.0","name":"test","bounds":[-1.0,-1.0,1.0,1.0],
            "imagery":{"sourceId":"quad","zoom":2}
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(
        cli(&home, &["plan", "--request", request.to_str().unwrap()])
            .status
            .success()
    );
    let bad = home.join("bad.json");
    fs::write(
        &bad,
        serde_json::to_vec(&json!({
            "schemaVersion":"1.0","name":"test","bounds":[-1.0,-1.0,1.0,1.0],
            "imagery":{"sourceId":"quad","zoom":2,"overlays":[{"sourceId":"unknown"}]}
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(!cli(&home, &["plan", "--request", bad.to_str().unwrap()])
        .status
        .success());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn probes_one_registered_raster_tile() {
    let home = temp_home();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(256, 256)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let png = cursor.into_inner();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut served = 0;
        while served < 2 && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut request = [0u8; 2048];
                    stream.read(&mut request).unwrap();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()).unwrap();
                    stream.write_all(&png).unwrap();
                    served += 1;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            }
        }
        assert_eq!(served, 2);
    });
    let url = format!("http://127.0.0.1:{port}/{{z}}/{{x}}/{{y}}.png");
    assert!(cli(
        &home,
        &[
            "sources",
            "register",
            "--id",
            "probe",
            "--name",
            "Probe",
            "--url",
            &url,
            "--attribution",
            "Fixture"
        ]
    )
    .status
    .success());
    let probe = cli(&home, &["sources", "probe", "--id", "probe"]);
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stdout)
    );
    assert_eq!(result(&probe)["width"], 256);
    let request = home.join("job.json");
    fs::write(
        &request,
        serde_json::to_vec(&json!({
            "schemaVersion":"1.0","name":"custom source fetch","bounds":[-1.0,-1.0,1.0,1.0],
            "imagery":{"sourceId":"probe","zoom":0,"format":"png"}
        }))
        .unwrap(),
    )
    .unwrap();
    let output = home.join("bundle");
    let fetched = cli(
        &home,
        &[
            "fetch",
            "--request",
            request.to_str().unwrap(),
            "--out",
            output.to_str().unwrap(),
        ],
    );
    server.join().unwrap();
    assert!(
        fetched.status.success(),
        "{}",
        String::from_utf8_lossy(&fetched.stdout)
    );
    assert_eq!(
        result(&fetched)["manifest"]["provenance"][0]["source"],
        "probe"
    );
    fs::remove_dir_all(home).unwrap();
}
