# StoryForgeAI presentation assets

Run the PowerShell generator from the repository root:

```powershell
& .\docs\presentations\generate-storyforge-deck.ps1
```

The generator requires desktop Microsoft PowerPoint on Windows. It creates and
validates these files under `docs/presentations/generated/`:

- `StoryForgeAI-Overview.pptx` — eight-slide business and technical overview
- `StoryForgeAI-Business-Infographic.pptx` — editable business-leader infographic
- `StoryForgeAI-Business-Infographic.png` — 1920x1080 image export
- `StoryForgeAI-Technical-Infographic.pptx` — editable solution-engineer infographic
- `StoryForgeAI-Technical-Infographic.png` — 1920x1080 image export

All diagrams and text are native PowerPoint objects. Application screenshots are
embedded from `public/screenshots/` to show the real product experience.

The narrative is grounded in `README.md` and `docs/architecture.md`. It avoids
unverified performance or cost claims and distinguishes the StoryForgeAI control
plane from the independent WanGP/Wan2GP media backend.
