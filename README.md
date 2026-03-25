# 📰 GitHub Changelog Weekly Summarizer

Automated weekly summaries of the [GitHub Blog Changelog](https://github.blog/changelog/) powered by [GitHub Agentic Workflows](https://github.github.com/gh-aw/).

Stay on top of what's shipping to GitHub customers — without reading every changelog post.

## What It Does

### 🗓️ Weekly Summary (Every Tuesday ~10AM CT)

An AI agent automatically:
1. Fetches the [GitHub Changelog RSS feed](https://github.blog/changelog/feed/)
2. Identifies the most impactful entries from the past week
3. Creates a GitHub Issue with:
   - **🔥 Top Highlights** — AI-written summaries of the biggest changes and why they matter
   - **👀 Watch List** — Deprecations, retirements, and items needing attention
   - **📋 Full Reference Table** — Every entry grouped by tags (Copilot, Actions, Security, etc.) with category, tags, and direct links
   - **📊 Quick Stats** — Entry count breakdown by category
4. Auto-closes the previous week's issue

### 💬 On-Demand Deep Dives (`/summarize`)

See an entry you want to know more about? Comment on any issue:

```
/summarize https://github.blog/changelog/2026-03-25-some-feature
```

The AI will fetch the full post and reply with a detailed breakdown:
- **TL;DR** — Executive summary
- **What Changed** — Technical details and scope
- **Why It Matters** — Customer impact analysis
- **Action Items** — Steps to take (if any)

## Setup

### Prerequisites

- [GitHub CLI](https://cli.github.com/) installed
- [GitHub Agentic Workflows CLI extension](https://github.github.com/gh-aw/setup/cli/)

### Installation

1. **Install the `gh aw` CLI extension:**
   ```bash
   gh extension install github/gh-aw
   ```

2. **Initialize the repository for agentic workflows** (if not already done):
   ```bash
   gh aw init
   ```

3. **Compile the workflows** to generate the lock files:
   ```bash
   gh aw compile changelog-weekly
   gh aw compile summarize-changelog
   ```

4. **Push to your repository** and the workflows will activate on the configured schedule.

### Manual Trigger

Run the weekly summary on-demand:

```bash
gh aw run changelog-weekly
```

Or with a custom lookback period:

```bash
gh aw run changelog-weekly --input days_back=14
```

## Configuration

### Changing the Schedule

Edit the `on.schedule` field in `changelog-weekly.md`:

```yaml
# Examples:
schedule:                                        # Default
    - cron: "0 10 * * 2"
      timezone: "America/Chicago"
schedule:                                        # Wednesday morning
    - cron: "0 9 * * 3"
      timezone: "America/Chicago"
schedule: daily around 9am utc-6                 # Daily
```

After changing frontmatter, recompile: `gh aw compile changelog-weekly`

### Changing the Assignee

Edit the `safe-outputs.create-issue.assignees` field in `changelog-weekly.md` and the `@username` mention in the footer.

### Labels

The weekly issue is automatically labeled with:
- `changelog-summary`

## How It Works

```
┌─────────────────────────────────────────────┐
│          Tuesday ~10AM CT (cron)             │
│     or manual: gh aw run changelog-weekly    │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│   🤖 AI Agent (GitHub Agentic Workflows)    │
│                                             │
│   1. Fetch RSS: github.blog/changelog/feed/ │
│   2. Parse & filter last 7 days             │
│   3. Identify top highlights                │
│   4. Generate summaries & reference table   │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│   📋 Safe Outputs                           │
│                                             │
│   • Create issue with summary               │
│   • Auto-close previous week's issue        │
│   • Assign @joshjohanning                   │
│   • Apply labels                            │
└─────────────────────────────────────────────┘
```

## License

[MIT](LICENSE)
