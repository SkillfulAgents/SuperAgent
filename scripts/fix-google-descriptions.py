#!/usr/bin/env python3
"""
Fetch full descriptions from Google Discovery Documents and update scope-maps.ts.
Replaces truncated descriptions (ending in "...") for Google API providers.
"""

import json
import re
import urllib.request

# Google Discovery Document URLs
DISCOVERY_URLS = {
    "gmail": "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    "googlecalendar": "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
    "googledrive": "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    "googlesheets": "https://sheets.googleapis.com/$discovery/rest?version=v4",
    "googledocs": "https://docs.googleapis.com/$discovery/rest?version=v1",
    "googletasks": "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest",
    "youtube": "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest",
}


def extract_methods(resource, base_path=""):
    """Recursively extract all methods from a Discovery Document resource."""
    methods = {}
    if "methods" in resource:
        for method_name, method_info in resource["methods"].items():
            http_method = method_info.get("httpMethod", "GET")
            # Build path pattern: replace {param} and {+param} with *
            path = method_info.get("flatPath") or method_info.get("path", "")
            description = method_info.get("description", "")
            # Use flatPath for more accurate patterns, normalize {param} to *
            path_pattern = re.sub(r"\{[^}]+\}", "*", path)
            # Ensure leading slash
            if not path_pattern.startswith("/"):
                path_pattern = "/" + path_pattern
            methods[(http_method, path_pattern)] = description

    if "resources" in resource:
        for res_name, res_info in resource["resources"].items():
            methods.update(extract_methods(res_info, base_path))

    return methods


def normalize_path(path):
    """Normalize a path pattern for matching: lowercase, collapse wildcards."""
    return re.sub(r"\*+", "*", path.lower().strip())


def main():
    scope_maps_path = "src/shared/lib/proxy/scope-maps.ts"

    with open(scope_maps_path, "r") as f:
        content = f.read()

    total_updated = 0

    for provider, url in DISCOVERY_URLS.items():
        print(f"\nFetching {provider} from {url}...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as resp:
                discovery = json.loads(resp.read().decode())
        except Exception as e:
            print(f"  ERROR fetching {provider}: {e}")
            continue

        # Extract all methods with full descriptions
        methods = extract_methods(discovery)
        print(f"  Found {len(methods)} methods in discovery doc")

        # Build lookup by normalized path
        lookup = {}
        for (http_method, path_pattern), description in methods.items():
            key = (http_method, normalize_path(path_pattern))
            lookup[key] = description

        # Find truncated descriptions in the file for this provider
        # Match lines like: description: "Some text..."
        # We need to match within the provider's section
        updated = 0

        # Find all truncated description entries with their method and pathPattern
        # Pattern: { method: "GET", pathPattern: "/gmail/v1/...", ..., description: "...truncated..." }
        entry_pattern = re.compile(
            r'\{ method: "([A-Z]+)", pathPattern: "([^"]+)",[^}]*description: "([^"]*\.\.\.)" \}'
        )

        for match in entry_pattern.finditer(content):
            method = match.group(1)
            path = match.group(2)
            old_desc = match.group(3)

            # Check this path belongs to the current provider by checking known prefixes
            provider_prefixes = {
                "gmail": "/gmail/",
                "googlecalendar": "/calendar/",
                "googledrive": "/drive/",
                "googlesheets": "/v4/spreadsheets",
                "googledocs": "/v1/documents",
                "googletasks": "/tasks/",
                "youtube": "/youtube/",
            }
            prefix = provider_prefixes.get(provider, "")
            if not path.startswith(prefix):
                continue

            key = (method, normalize_path(path))
            if key in lookup:
                new_desc = lookup[key]
                # Escape for TS string (double quotes, backslashes)
                new_desc = new_desc.replace("\\", "\\\\").replace('"', '\\"')
                old_full = f'description: "{old_desc}"'
                new_full = f'description: "{new_desc}"'
                content = content.replace(old_full, new_full, 1)
                updated += 1
                if len(old_desc) < len(new_desc):
                    print(f"  Updated: {method} {path}")
                    print(f"    Old ({len(old_desc)} chars): {old_desc[:80]}...")
                    print(f"    New ({len(new_desc)} chars): {new_desc[:80]}...")
            else:
                # Try fuzzy match: strip basePath prefix variations
                found = False
                for (lm, lp), desc in lookup.items():
                    if lm == method and normalize_path(path).endswith(lp.split("/", 2)[-1] if "/" in lp else lp):
                        new_desc = desc.replace("\\", "\\\\").replace('"', '\\"')
                        old_full = f'description: "{old_desc}"'
                        new_full = f'description: "{new_desc}"'
                        content = content.replace(old_full, new_full, 1)
                        updated += 1
                        found = True
                        print(f"  Updated (fuzzy): {method} {path}")
                        break
                if not found:
                    print(f"  NOT FOUND: {method} {path}")

        print(f"  Updated {updated} descriptions for {provider}")
        total_updated += updated

    with open(scope_maps_path, "w") as f:
        f.write(content)

    print(f"\nDone! Updated {total_updated} descriptions total.")


if __name__ == "__main__":
    main()
