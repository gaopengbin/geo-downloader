use serde_json::{json, Value};
use std::{fs, process::Command};

fn invoke(home: &std::path::Path, args: &[&str]) -> (bool, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_geod"))
        .env("GEOD_CLI_HOME", home)
        .env_remove("GEOD_SERVER_AUTHENTICATED")
        .args(args)
        .output()
        .unwrap();
    (
        output.status.success(),
        serde_json::from_slice(&output.stdout).unwrap(),
    )
}

#[test]
fn anonymous_fetch_checks_effective_highest_zoom_before_network() {
    let home = std::env::temp_dir().join(format!("geod-auth-policy-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let (registered, _) = invoke(
        &home,
        &[
            "sources",
            "register",
            "--id",
            "fixture",
            "--name",
            "Fixture",
            "--url",
            "http://127.0.0.1:1/{z}/{x}/{y}.png",
            "--attribution",
            "Fixture",
            "--max-zoom",
            "22",
        ],
    );
    assert!(registered);
    let request_path = home.join("request.json");
    let output_path = home.join("out");
    for (levels, required) in [(vec![5], false), (vec![5, 6], true), (vec![5, 7], true)] {
        fs::write(&request_path, serde_json::to_vec(&json!({"schemaVersion":"1.0","name":"policy",
            "bounds":[0.0,0.0,0.001,0.001],"imagery":{"sourceId":"fixture","zoom":5,"zoomMax":6,"zoomLevels":levels}})).unwrap()).unwrap();
        let (planned, plan) = invoke(
            &home,
            &["plan", "--request", request_path.to_str().unwrap()],
        );
        assert!(planned, "{plan}");
        assert_eq!(plan["loginRequired"], required);
        let (fetched, fetch) = invoke(
            &home,
            &[
                "fetch",
                "--request",
                request_path.to_str().unwrap(),
                "--out",
                output_path.to_str().unwrap(),
            ],
        );
        if required {
            assert!(!fetched);
            assert_eq!(fetch["error"]["code"], "LOGIN_REQUIRED");
            assert!(!output_path.exists());
        } else {
            // The test source intentionally has no listener. Reaching its network error
            // proves zoom 5 passed the account gate.
            assert!(!fetched);
            assert_ne!(fetch["error"]["code"], "LOGIN_REQUIRED");
        }
    }
    let (probed, probe) = invoke(
        &home,
        &[
            "sources", "probe", "--id", "fixture", "--zoom", "6", "--x", "0", "--y", "0",
        ],
    );
    assert!(!probed);
    assert_eq!(probe["error"]["code"], "LOGIN_REQUIRED");
    let (analyzed, analysis) = invoke(
        &home,
        &[
            "sources",
            "analyze",
            "--url",
            "http://127.0.0.1:1/6/0/0.png",
        ],
    );
    assert!(!analyzed);
    assert_eq!(analysis["error"]["code"], "LOGIN_REQUIRED");
    fs::remove_dir_all(home).unwrap();
}
