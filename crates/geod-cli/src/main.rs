use geod_core::pipeline;
mod sources;
mod auth;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const HELP: &str = r#"Download and inspect imagery and boundary data

  geod plan --request job.json
  geod fetch --request job.json --out ./outputs/map [--work-dir ./work/map]
  geod inspect --bundle ./outputs/map
  geod sources list
  geod sources register --id my_source --name "My imagery" --url "https://example.com/{z}/{x}/{y}.png" --attribution "Provider"
  geod sources default --id my_source
  geod sources probe --id my_source [--zoom 0 --x 0 --y 0]
  geod auth login|status|logout
Use --source ID with plan/fetch, or imagery.sourceId in job.json. A default
source is used when imagery has no url/sourceId. Registered sources are local
to this user's GeoD CLI configuration; they are not uploaded to GeoD.
Results are JSON on stdout; progress is JSON lines on stderr. --json is accepted.
fetch is synchronous and never overwrites an existing output directory.
--work-dir retains validated tiles so the same request can resume after interruption.
Bounds are WGS84 [west,south,east,north]. Raster grids are EPSG:3857.
See docs/geod-cli-0.3.md and examples/geod-cli for the versioned request contract.
"#;

fn options(args: &[String], allowed: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--json" {
            index += 1;
            continue;
        }
        if !allowed.contains(&arg.as_str()) {
            return Err(format!("Unknown argument: {arg}"));
        }
        let value = args
            .get(index + 1)
            .filter(|s| !s.starts_with("--"))
            .ok_or_else(|| format!("Missing value for {arg}"))?;
        if values.insert(arg.clone(), value.clone()).is_some() {
            return Err(format!("Duplicate argument: {arg}"));
        }
        index += 2;
    }
    Ok(values)
}
fn required<'a>(args: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("Missing {key}"))
}
fn absolute(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(std::env::current_dir().map_err(|e| e.to_string())?.join(p))
    }
}

async fn run(command: &str, args: &[String]) -> Result<Value, String> {
    match command {
        "plan" => {
            let options = options(args, &["--request", "--source"])?;
            let request = sources::read_request(
                Path::new(required(&options, "--request")?),
                options.get("--source").map(String::as_str),
            )?;
            let mut plan = pipeline::plan_local(&request)?;
            let highest = request.imagery.as_ref().map(|image| pipeline::selected_zooms(image))
                .transpose()?.and_then(|levels| levels.into_iter().max()).unwrap_or(0);
            if let Some(object) = plan.as_object_mut() {
                object.insert("loginRequired".into(), json!(highest > auth::FREE_MAX_ZOOM));
                object.insert("anonymousMaxZoom".into(), json!(auth::FREE_MAX_ZOOM));
            }
            Ok(plan)
        }
        "fetch" => {
            let options = options(args, &["--request", "--out", "--work-dir", "--source"])?;
            let path = absolute(required(&options, "--request")?)?;
            let request =
                sources::read_request(&path, options.get("--source").map(String::as_str))?;
            auth::require_request(&request).await?;
            let out = absolute(required(&options, "--out")?)?;
            let work_dir = options
                .get("--work-dir")
                .map(|value| absolute(value))
                .transpose()?;
            let manifest = pipeline::fetch_local_with_work_dir(
                request,
                path.parent().ok_or("Invalid request path")?,
                &out,
                work_dir.as_deref(),
            )
            .await?;
            Ok(
                json!({"ok":true,"bundleDir":out,"manifestPath":out.join("manifest.json"),"manifest":manifest}),
            )
        }
        "inspect" => {
            let options = options(args, &["--bundle"])?;
            Ok(
                json!({"ok":true,"manifest":pipeline::inspect(Path::new(required(&options,"--bundle")?))?}),
            )
        }
        "sources" => sources::run(args).await,
        "auth" => auth::run(args).await,
        "geostyle-import" => {
            let options = options(args, &["--bundle", "--url", "--token-env", "--style"])?;
            let token = options
                .get("--token-env")
                .map(|name| {
                    std::env::var(name)
                        .map_err(|_| format!("Token environment variable {name} is missing"))
                })
                .transpose()?;
            let style = options
                .get("--style")
                .map(|path| -> Result<Value, String> {
                    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
                        return Err("OpenStyle file exceeds 2 MiB".into());
                    }
                    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("Invalid OpenStyle JSON: {e}"))
                })
                .transpose()?;
            let result = pipeline::import_geostyle(
                Path::new(required(&options, "--bundle")?),
                required(&options, "--url")?,
                token.as_deref(),
                style,
            )
            .await?;
            let base = required(&options, "--url")?.trim_end_matches('/');
            let full_url = |key: &str| result[key].as_str().map(|path| format!("{base}{path}"));
            Ok(json!({"ok":true,"geostyle":{
                "id":result["id"],
                "createPath":result["createPath"],"renderPath":result["renderPath"],"manifestPath":result["manifestPath"],
                "createUrl":full_url("createPath"),"renderUrl":full_url("renderPath"),"manifestUrl":full_url("manifestPath"),
                "quality":result["manifest"]["quality"],
                "layers":result["manifest"]["layers"]
            }}))
        }
        _ => Err(format!("Unknown command: {command}; run geod --help")),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|s| s == "--help" || s == "-h") {
        print!("GeoD CLI {}\n{HELP}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args == ["--version"] {
        println!("geod {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let result = tokio::select! {
        result=run(&args[0],&args[1..])=>result,
        _=tokio::signal::ctrl_c()=>Err("CANCELLED: operation interrupted".into()),
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string(&value).expect("JSON result")),
        Err(message) => {
            let code = message
                .split(':')
                .next()
                .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
                .unwrap_or("GEOD_ERROR");
            println!(
                "{}",
                json!({"ok":false,"error":{"code":code,"message":message}})
            );
            std::process::exit(if code == "CANCELLED" { 130 } else { 1 });
        }
    }
}
