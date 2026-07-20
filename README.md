# Komari Theme 1999

A neo-brutalist monitoring dashboard for [Komari Monitor](https://github.com/komari-monitor/komari), featuring heavy borders, hard shadows, pixel-inspired loading states, and responsive node detail charts.

## Features

- Responsive grid and list views with persistent view preference
- Dynamic site name from Komari public settings
- Live CPU, memory, disk, network, uptime, and latency data
- Node detail modal with hardware, system, storage, and network summaries
- ECharts history views for load and latency with independent time ranges
- Managed accent color, card border style, and uptime visibility options
- Keyboard-friendly modal controls, including `Esc` to close

## Installation

1. Download `komari-theme-v*.zip` from a release or GitHub Actions artifact.
2. Open the Komari admin panel and go to theme management.
3. Upload the ZIP package and select **Komari Theme - 1999**.
4. Refresh the monitor page.

The package contains `komari-theme.json` and the compiled files under `dist/`.

## Development

### Requirements

- Node.js 18 or newer
- npm
- `zip`

No npm dependencies are currently required. ECharts and web fonts are loaded from public CDNs at runtime.

```bash
npm run build      # Copy source files into dist/
npm run package    # Build and create komari-theme-v<version>.zip
npm run clean      # Remove dist/
```

To preview locally, run `npm run build` and serve `dist/` with a static server. API-backed data requires a Komari installation.

## Project Structure

```text
src/
├── index.html       # Dashboard template and required Komari placeholders
├── styles.css       # Theme, responsive, modal, and animation styles
└── script.js        # RPC data, rendering, preferences, and ECharts logic
custom-body/         # Optional Komari custom-body snippets
komari-theme.json    # Theme metadata and managed settings
build-theme.sh       # ZIP packaging script
.github/workflows/   # CI build and artifact upload
```

`dist/` and `*.zip` are generated files and are ignored by Git.

## Configuration

Managed settings are declared in `komari-theme.json`:

| Setting | Values | Default |
| --- | --- | --- |
| Accent Color | `yellow`, `red`, `blue`, `green`, `purple` | `yellow` |
| Card Style | `thick`, `thin`, `double` | `thick` |
| Show Uptime | on/off | on |

Keep the versions in `package.json` and `komari-theme.json` synchronized before packaging a release.

## CI

`.github/workflows/build-ci.yml` runs for pushes and pull requests targeting `main`, and can also be started manually. It packages the theme with Node.js 20 and uploads `komari-theme-v*.zip` as a GitHub Actions artifact.

## Komari Compatibility

The template preserves the required title, description, `</head>`, and `</body>` placeholders used by Komari. It also keeps the **Powered by Komari Monitor** footer attribution. User preferences use Komari-compatible localStorage keys such as `nodeViewMode`.

## References

- [Komari Theme Development Guide](https://komari-document.pages.dev/dev/theme.html)
- [Komari Web](https://github.com/komari-monitor/komari-web)

## Acknowledgements

Special thanks to [komari-theme-naive](https://github.com/lyimoexiao/komari-theme-naive) by [lyimoexiao](https://github.com/lyimoexiao). Its chart presentation, historical-data handling, and packaging approach provided valuable reference and inspiration.

## License

MIT
