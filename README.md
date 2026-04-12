# workouts

Single-file workout log plus a local chart dashboard.

## Files
- `workouts.yml`: source of truth for workout logs
- `workouts.json`: dashboard data generated from `workouts.yml`
- `index.html`, `styles.css`, `app.js`: local dashboard UI

## Regenerate Dashboard Data
```bash
ruby -e 'require "yaml"; require "json"; d=YAML.load_file("workouts.yml"); File.write("workouts.json", JSON.pretty_generate(d))'
```

## Run Locally
```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.
