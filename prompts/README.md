# Security Scanning Prompts

This directory contains package-specific entry prompts for the CVE Finder tool. **Common workflow, exclusions, and JSON output live in [`skills/cve-ai-finder/SKILL.md`](../skills/cve-ai-finder/SKILL.md).** Language-specific rules live in [`skills/cve-ai-finder/prompts/`](../skills/cve-ai-finder/prompts/).

## Overview

Different package ecosystems have different vulnerability patterns and security concerns. Each `cursor_prompt_*.txt` file selects a language and points at the matching language prompt under `skills/cve-ai-finder/prompts/`.

## Available Prompts

| Entry file | Language | Skill sub-skill | Prompt file |
|---|---|---|---|
| `cursor_prompt_pip.txt` | Python/pip | `python/` | `prompts/pip.txt` |
| `cursor_prompt_node-ts.txt` | Node.js/TypeScript | `node-ts/` | `prompts/node-ts.txt` |
| `cursor_prompt_maven.txt` | Java/Maven (incl. Kotlin) | `java-kotlin/` | `prompts/maven.txt` |
| `cursor_prompt_go.txt` | Go | `go/` | `prompts/go.txt` |
| `cursor_prompt_rust.txt` | Rust | `rust/` | `prompts/rust.txt` |
| `cursor_prompt_ruby.txt` | Ruby | `ruby/` | `prompts/ruby.txt` |
| `cursor_prompt_php.txt` | PHP | `php/` | `prompts/php.txt` |
| `cursor_prompt_c-cpp.txt` | C/C++ (incl. ObjC `.m`/`.mm`) | `c-cpp/` | `prompts/c-cpp.txt` |
| `cursor_prompt_csharp.txt` | C# / .NET | `csharp/` | `prompts/csharp.txt` |
| `cursor_prompt_pub.txt` | Dart/Flutter | `dart-flutter/` | `prompts/pub.txt` |
| `cursor_prompt_swift.txt` | Swift | `swift/` | `prompts/swift.txt` |

**Not covered (yet):** Scala, Elixir, Lua, Shell — add via the same pattern if needed.

## Configuration

Set the `PACKAGE_TYPE` environment variable in `.env` to select which prompt to use:

```bash
# For Node.js/JavaScript projects
PACKAGE_TYPE=npm

# For Java/Maven projects
PACKAGE_TYPE=maven

# For Python projects
PACKAGE_TYPE=pip

# For Go projects
PACKAGE_TYPE=go

# For C/C++ projects
PACKAGE_TYPE=c-cpp

# For C# / .NET projects
PACKAGE_TYPE=csharp
```

## How It Works

1. Invoke the **`cve-ai-finder`** skill (or load a language sub-skill explicitly).
2. The orchestrator loads [`skills/cve-ai-finder/SKILL.md`](../skills/cve-ai-finder/SKILL.md) for shared rules and JSON markers.
3. Each language sub-skill reads its prompt from `skills/cve-ai-finder/prompts/{lang}.txt`.
4. Legacy entry files `cursor_prompt_{PACKAGE_TYPE}.txt` in this directory point at the same skill bundle.
5. Output uses `<<<CVE_HUNTER_FINDINGS_JSON>>>` and `<<<CVE_HUNTER_DROPS_JSON>>>` markers (no Semgrep required).

## Scan scope: CLI-only exclusion

Vulnerabilities that are **only** triggerable by the user running the tool with malicious command-line arguments are **excluded from the scan scope**. Examples: `process.argv`, `--config`, `sys.argv`, `os.Args`, `main(String[] args)`. In those cases the "attacker" would be the user themselves—not remotely exploitable. The prompts instruct the model to treat these as false positives / out of scope. Findings are still reported when untrusted data can come from the network (e.g. HTTP, WebSocket), from config/files another actor could influence, or from any other external input.

## Prompt Structure

Split across the skill bundle (no duplication):

| Location | Content |
|---|---|
| `skills/cve-ai-finder/SKILL.md` | Workflow, global exclusions, severity, JSON markers, drops channel, example finding |
| `skills/cve-ai-finder/prompts/*.txt` | Language-specific paths, sources/sinks, vulnerability types |
| `prompts/cursor_prompt_*.txt` | Thin entry stub + pointer to skill files |

## Semgrep Triage Prompt

The `semgrep-triage.txt` prompt is used for triaging Semgrep findings in semgrep mode. It's package-agnostic and focuses on validating whether Semgrep findings are true positives by:
- Performing source-to-sink analysis
- Checking for sanitization between source and sink
- Excluding test/example directories
- Filtering by severity

## Adding New Package Types

To add support for a new package ecosystem:

1. Create a new prompt file: `cursor_prompt_{package_type}.txt`
2. Follow the structure of existing prompts
3. Include ecosystem-specific vulnerability types
4. Update the `PACKAGE_TYPE` validation in `backend/src/config/index.ts`
5. Update this README

## Best Practices

- Keep prompts focused on **production code** vulnerabilities
- Emphasize **source-to-sink** analysis for accuracy
- Include **specific examples** of dangerous patterns for the ecosystem
- Document **safe alternatives** to help reduce false positives
- Test prompts with real repositories to validate effectiveness
