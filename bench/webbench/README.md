# WebBench Assets

Place downloaded WebBench CSV files here.

Expected default filename:
- `webbenchfinal.csv`

Then generate runnable cases:
`npm run webbench:import -- --csv ./bench/webbench/webbenchfinal.csv --out ./bench/scenarios/cases/webbench-read-sample.json --categories READ --limit 50 --max-per-domain 1`
