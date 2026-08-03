---
on:
  schedule:
    - cron: "0 10 * * 2"
      timezone: "America/Chicago"
  workflow_dispatch:
    inputs:
      days_back:
        description: 'Number of days to look back for changelog entries (default: 7)'
        required: false
        type: string
        default: "7"

permissions:
  contents: read
  issues: read

runs-on: ubuntu-latest
runs-on-slim: ubuntu-latest

model: claude-sonnet-4.5
engine:
  id: copilot
timeout-minutes: 20

steps:
  - name: Compute changelog date range
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GITHUB_REPOSITORY: ${{ github.repository }}
      GITHUB_EVENT_NAME: ${{ github.event_name }}
      DAYS_BACK: ${{ github.event.inputs.days_back || '7' }}
      TZ: America/Chicago
    run: |
      python3 <<'PY'
      import json
      import os
      import re
      import urllib.parse
      import urllib.request
      from datetime import datetime, timedelta
      from pathlib import Path
      from zoneinfo import ZoneInfo

      token = os.environ["GITHUB_TOKEN"]
      repo = os.environ["GITHUB_REPOSITORY"]
      event_name = os.environ.get("GITHUB_EVENT_NAME", "")
      days_back_raw = os.environ.get("DAYS_BACK", "7").strip() or "7"
      try:
          days_back = int(days_back_raw)
      except ValueError:
          days_back = 7

      today = datetime.now(ZoneInfo(os.environ.get("TZ", "UTC"))).date()
      manual_override = event_name == "workflow_dispatch" and days_back != 7

      def api(path, query=None):
          url = f"https://api.github.com{path}"
          if query:
              url += "?" + urllib.parse.urlencode(query)
          req = urllib.request.Request(
              url,
              headers={
                  "Accept": "application/vnd.github+json",
                  "Authorization": f"Bearer {token}",
                  "X-GitHub-Api-Version": "2022-11-28",
                  "User-Agent": "github-changelog-weekly-date-range",
              },
          )
          with urllib.request.urlopen(req, timeout=15) as response:
              return json.loads(response.read().decode("utf-8"))

      def parse_issue_end_date(title):
          match = re.search(
              r"([A-Z][a-z]{2} \d{1,2}, \d{4})\s*[–-]\s*([A-Z][a-z]{2} \d{1,2}, \d{4})",
              title,
          )
          if not match:
              return None
          return datetime.strptime(match.group(2), "%b %d, %Y").date()

      def issue_title(start_date, end_date):
          date_range = f"{start_date:%b} {start_date.day}, {start_date:%Y} – {end_date:%b} {end_date.day}, {end_date:%Y}"
          if (end_date - start_date).days == 6:
              return f"Week of {date_range}"
          return date_range

      previous = None
      if not manual_override:
          issues = api(
              f"/repos/{repo}/issues",
              {
                  "state": "all",
                  "labels": "changelog-summary",
                  "sort": "created",
                  "direction": "desc",
                  "per_page": "30",
              },
          )
          for issue in issues:
              if "pull_request" in issue:
                  continue
              title = issue.get("title", "")
              if not title.startswith("[Changelog] "):
                  continue
              end_date = parse_issue_end_date(title)
              if not end_date:
                  continue
              previous = {
                  "number": issue["number"],
                  "title": title,
                  "url": issue["html_url"],
                  "end_date": end_date.isoformat(),
              }
              break

      if manual_override:
          start = today - timedelta(days=max(days_back, 1) - 1)
          end = today
          mode = "manual_override"
      elif previous:
          previous_end = datetime.fromisoformat(previous["end_date"]).date()
          if previous_end >= today:
              start = today
              end = today
              mode = "noop"
          else:
              start = previous_end + timedelta(days=1)
              end = min(start + timedelta(days=6), today)
              mode = "backfill"
      else:
          start = today - timedelta(days=max(days_back, 1) - 1)
          end = today
          mode = "fallback"

      output = {
          "mode": mode,
          "start_date": start.isoformat(),
          "end_date": end.isoformat(),
          "title": issue_title(start, end),
          "days_back": days_back,
          "previous_issue": previous,
      }

      out_path = Path("/tmp/gh-aw/agent/changelog-date-range.json")
      out_path.parent.mkdir(parents=True, exist_ok=True)
      out_path.write_text(json.dumps(output, indent=2) + "\n")
      print(json.dumps(output, indent=2))
      PY

  - name: Fetch changelog entries
    run: |
      python3 <<'PY'
      import html
      import json
      import re
      import urllib.error
      import urllib.request
      import xml.etree.ElementTree as ET
      from datetime import date, datetime
      from email.utils import parsedate_to_datetime
      from pathlib import Path

      base = Path("/tmp/gh-aw/agent")
      date_range = json.loads((base / "changelog-date-range.json").read_text())
      start = date.fromisoformat(date_range["start_date"])
      end = date.fromisoformat(date_range["end_date"])

      def fetch(page):
          url = "https://github.blog/changelog/feed/"
          if page > 1:
              url += f"?paged={page}"
          req = urllib.request.Request(url, headers={"User-Agent": "GitHub-Changelog-Bot/1.0"})
          return urllib.request.urlopen(req, timeout=30).read()

      def strip_html(value):
          text = re.sub(r"<[^>]+>", " ", value or "")
          return html.unescape(re.sub(r"\s+", " ", text).strip())

      entries = {}
      oldest_seen = None
      for page in range(1, 101):
          try:
              raw = fetch(page)
          except urllib.error.HTTPError as err:
              if err.code == 404:
                  break
              raise
          items = ET.fromstring(raw).findall(".//item")
          if not items:
              break
          for item in items:
              link = (item.findtext("link") or "").strip()
              if not link or link in entries:
                  continue
              published = parsedate_to_datetime(item.findtext("pubDate")).date()
              oldest_seen = published if oldest_seen is None else min(oldest_seen, published)
              if not (start <= published <= end):
                  continue
              categories = item.findall("category")
              entry_type = next(
                  (c.text for c in categories if c.get("domain") == "changelog-type" and c.text),
                  "Other",
              )
              tags = [c.text for c in categories if c.get("domain") == "changelog-label" and c.text]
              entries[link] = {
                  "title": strip_html(item.findtext("title")),
                  "link": link,
                  "date": published.isoformat(),
                  "type": entry_type,
                  "tags": tags,
                  "summary": strip_html(item.findtext("description"))[:1200],
              }
          if oldest_seen and oldest_seen < start:
              break

      sorted_entries = sorted(entries.values(), key=lambda e: (e["date"], e["title"]), reverse=True)
      counts = {}
      for entry in sorted_entries:
          counts[entry["type"]] = counts.get(entry["type"], 0) + 1

      payload = {
          "start_date": start.isoformat(),
          "end_date": end.isoformat(),
          "title": date_range["title"],
          "total": len(sorted_entries),
          "counts_by_type": counts,
          "fetched_at": datetime.utcnow().isoformat() + "Z",
          "entries": sorted_entries,
      }
      (base / "changelog-entries.json").write_text(json.dumps(payload, indent=2) + "\n")

      def short_date(value):
          parsed = date.fromisoformat(value)
          return f"{parsed:%b} {parsed.day}"

      def cell(value):
          return (value or "").replace("|", "\\|")

      rows = [
          "| Date | Entry | Category | Tags | Link |",
          "|------|-------|----------|------|------|",
      ]
      for entry in sorted_entries:
          tags = ", ".join(f"`{cell(tag)}`" for tag in entry["tags"]) or "—"
          rows.append(
              f"| {short_date(entry['date'])} | {cell(entry['title'])} | {cell(entry['type'])} "
              f"| {tags} | [Changelog]({entry['link']}) |"
          )
      (base / "changelog-table.md").write_text("\n".join(rows) + "\n")
      print(f"Fetched {len(sorted_entries)} entries between {start} and {end}: {counts}")
      PY

tools:
  bash: ["date", "echo", "cat", "head", "tail", "grep", "sort", "wc", "sed", "awk", "tr", "cut", "python3"]
  github:
    toolsets: [issues]
    min-integrity: none

network:
  allowed:
    - defaults
    - github

safe-outputs:
  create-issue:
    title-prefix: "[Changelog] "
    labels: [changelog-summary]
    assignees: [joshjohanning]
    expires: 7d
---

# 📰 Weekly GitHub Changelog Summarizer

You are an AI assistant that creates a weekly summary of the GitHub Blog Changelog for a GitHub employee who wants to stay on top of what's shipping to customers.

## Your Task

1. **Read the precomputed target date range** from `/tmp/gh-aw/agent/changelog-date-range.json` (see below)
2. **Read the precomputed changelog entries** from `/tmp/gh-aw/agent/changelog-entries.json` (see below)
3. **Analyze and summarize** the most impactful entries
4. **Create a well-formatted GitHub Issue** with the summary

## How to Choose the Date Range

This workflow backfills missed weekly runs instead of always summarizing the latest posts. A deterministic pre-agent step has already calculated the range and written it to `/tmp/gh-aw/agent/changelog-date-range.json`.

1. Read and parse `/tmp/gh-aw/agent/changelog-date-range.json` first.
2. Use `start_date`, `end_date`, and `title` from that file as the source of truth for filtering, the issue title, quick stats, and the "No new changelog entries" fallback.
3. If `mode` is `noop`, do not create a duplicate changelog issue. Use `noop` to report that the changelog summary is already up to date, including the `previous_issue` title and URL if present.
4. If the file is missing or unreadable, fall back to the last ${{ github.event.inputs.days_back || '7' }} days ending today.

## Where the Entry Data Comes From

A deterministic pre-agent step has already fetched, deduplicated, filtered, and sorted every changelog entry in the target date range. The data is at `/tmp/gh-aw/agent/changelog-entries.json`:

```json
{
  "start_date": "2026-05-27",
  "end_date": "2026-07-28",
  "title": "May 27, 2026 – Jul 28, 2026",
  "total": 187,
  "counts_by_type": { "Release": 104, "Improvement": 70 },
  "entries": [
    { "title": "...", "link": "https://github.blog/changelog/...", "date": "2026-07-28", "type": "Release", "tags": ["copilot"], "summary": "..." }
  ]
}
```

A companion file `/tmp/gh-aw/agent/changelog-table.md` contains the **complete, pre-rendered Markdown reference table** for every entry in the range.

**These two files are the ONLY source of truth.**

- Do NOT fetch the RSS feed yourself. Do NOT use `web-fetch` or `curl` — they are blocked by the sandbox firewall.
- Do NOT invent, guess, or recall any entry, title, URL, date, or tag from memory. Every value you write must be copied verbatim from this file.
- For the "Complete Changelog Reference" section, `cat /tmp/gh-aw/agent/changelog-table.md` and reproduce its contents **verbatim, in full**. Do not regenerate, re-sort, re-word, shorten, sample, or summarize it, and never replace rows with `...`.
- Take the entry counts for the stats line from `total` and `counts_by_type`.
- Before creating the issue, verify that every `https://github.blog/changelog/...` URL in your issue body appears in `changelog-entries.json`. If any does not, you invented it — remove it and start again from the file.

## How to Structure the Issue

### Title
Adapt the title based on the target date range:
- If the target range is exactly 7 days: `Week of Mar 19, 2026 – Mar 25, 2026`
- If the target range is not exactly 7 days: `Mar 1, 2026 – Mar 25, 2026` (just the date range, no "Week of")

Use abbreviated 3-letter month names (Jan, Feb, Mar, etc.). The start and end dates should match the target date range determined above.

The safe-output will automatically prepend "[Changelog] " to the title.

### Body

Structure the issue body as follows:

#### 1. Header & Quick Stats
Start with a brief intro line and a stats summary:

```
📊 **[N] changelog entries** this week — [X] new releases, [Y] improvements, [Z] other
```

If there are any retired/deprecated entries, call those out specifically:
```
⚠️ **[N] deprecation(s)/retirement(s) this week** — review these for potential impact
```

#### 2. 🔥 Top Highlights (3-6 entries max)

Pick the **most impactful** entries — new major features, significant improvements, breaking changes, deprecations/retirements, security updates, or anything a GitHub employee would want to know about. These are entries that affect how customers use GitHub or represent significant platform changes.

For each highlighted entry, write:
- A **bold title** that links to the changelog post
- A **2-3 sentence summary** explaining what changed and **why it matters** for customers/the platform
- The category tags as badges (e.g., `copilot`, `actions`)

Format example:
```
### [Title of the Entry](https://github.blog/changelog/...)
`copilot` `enterprise` · Improvement

Brief summary of what changed and why it matters for customers. This enables X and means Y for users who do Z.
```

**Do NOT summarize every single entry.** Only highlight the ones that really matter. The full list is in the reference table below.

#### 3. 👀 Watch List (optional)

If there are entries that might require action or attention (deprecations, retirements, breaking changes, security updates, policy changes), list them briefly in a callout:

```
> **👀 Items that may need attention:**
> - [Entry title](link) — Brief reason why (e.g., "deprecation effective April 1")
> - [Entry title](link) — Brief reason why
```

Skip this section if nothing needs attention.

#### 4. 📋 Complete Changelog Reference

Create a table of ALL entries from the week. Each entry should appear once with all its tags listed.

Format as a Markdown table with **5 columns** — include the publish date, keep the title as plain text for readability, with the link in a separate column:

```
### 📋 Complete Changelog Reference

| Date | Entry | Category | Tags | Link |
|------|-------|----------|------|------|
| Mar 25 | Title of entry | Improvement | `copilot`, `enterprise` | [Changelog](url) |
| Mar 24 | Title of entry | Release | `actions` | [Changelog](url) |
| ... | ... | ... | ... | ... |
```

Sort the table by date (newest first). Use short date format without year (e.g., `Mar 25`). If an entry has multiple tags, list it once with all its tags. **Always use the full, untruncated title in the Entry column — never shorten or abbreviate titles.**

**Do not build this table yourself.** Read `/tmp/gh-aw/agent/changelog-table.md` and paste its contents verbatim — it is already sorted newest-first, uses short dates, and contains exactly one row per entry. No exceptions, no `...`, no sampling, no truncation.

**Mandatory verification before you create the issue:**

1. Run `wc -l < /tmp/gh-aw/agent/changelog-table.md` to get the expected line count (header + separator + one row per entry).
2. Count the table lines in the body you are about to submit. It must match exactly.
3. Silently dropping rows because the table is long is a failure. If the counts differ, re-read the file and rebuild the section before submitting.

The table is long by design — copying all of it is the single most important part of this task.

#### 5. Footer

End with:
```
---
_This summary was auto-generated from the [GitHub Changelog RSS feed](https://github.blog/changelog/). Use `/summarize <url>` on this issue to get a deeper dive into any specific entry._
```

## Important Guidelines

- Be concise but informative in highlights — a GitHub employee should understand the customer impact in seconds
- Group and organize information so the issue is scannable
- Use emoji sparingly but effectively for visual scanning
- Always include direct hyperlinks to every changelog post
- If the RSS feed has no entries in the time range, create an issue noting "No new changelog entries this week" with a brief note
- The goal is to save time — the reader should get 80% of the value from the highlights section alone, and use the reference table to drill into specifics
- Focus on what matters for GitHub employees: customer impact, platform changes, new capabilities, deprecations
- **Do NOT write to `/tmp/gh-aw/`** — that directory is read-only. Use `/tmp/` directly for any temp files (e.g., `/tmp/changelog-data.json`)
