import os
import re
import urllib.parse
import sys

def check_markdown_links(root_dir):
    md_files = []
    for root, dirs, files in os.walk(root_dir):
        # Skip node_modules and .git
        if 'node_modules' in root or '.git' in root:
            continue
        for f in files:
            if f.endswith('.md'):
                md_files.append(os.path.join(root, f))
    
    # regex to find standard markdown links: [text](link)
    # excludes [text] alone or [[wikilinks]]
    link_pattern = re.compile(r'\[([^\[\]]+)\]\(([^)]+)\)')
    broken_links = []

    for md_file in md_files:
        with open(md_file, 'r', encoding='utf-8') as f:
            content = f.read()
            links = link_pattern.findall(content)
            for text, link in links:
                print(f"Checking link in {md_file}: [{text}]({link})")
                # Ignore web links and email links
                if link.startswith('http') or link.startswith('mailto:'):
                    continue
                
                # Split link and anchor
                parts = link.split('#')
                link_path = urllib.parse.unquote(parts[0])
                anchor = parts[1] if len(parts) > 1 else None

                # Handle anchor-only links
                if not link_path:
                    if anchor:
                        # Verify anchor exists in current file
                        if not verify_anchor(md_file, anchor, debug=True):
                            broken_links.append((md_file, link, "Broken Anchor"))
                    continue

                # Resolve relative path
                target_path = os.path.normpath(os.path.join(os.path.dirname(md_file), link_path))
                
                # Check file existence (must be a file or dir)
                # But links to directories should usually have a trailing slash or be handled
                exists = os.path.exists(target_path)
                print(f"  Path: {target_path} -> Exists: {exists}")
                if not exists:
                    broken_links.append((md_file, link, "Broken Path"))
                elif anchor:
                    # Verify anchor exists in target file
                    res = verify_anchor(target_path, anchor, debug=True)
                    print(f"  Result: {'OK' if res else 'FAILED'}")
                    if not res:
                        broken_links.append((md_file, link, f"Broken Anchor in {target_path}"))
    
    if broken_links:
        print("Broken links found:")
        for f, l, err in broken_links:
            print(f"File: {f} -> Link: {l} ({err})")
        return False
    else:
        print("No broken local links found.")
        return True

def generate_github_slug(text):
    """
    Simulates GitHub's anchor generation logic.
    - Lowercase
    - Remove punctuation (including dots)
    - Replace spaces with hyphens
    - Collapse multiple hyphens
    """
    # Lowercase
    slug = text.lower()
    # Replace spaces with hyphens
    slug = slug.replace(' ', '-')
    # Remove everything except letters, numbers, hyphens, and underscores
    slug = re.sub(r'[^a-z0-9\-_]', '', slug)
    # Collapse multiple hyphens
    slug = re.sub(r'-+', '-', slug)
    # Strip leading/trailing hyphens
    slug = slug.strip('-')
    return slug

def verify_anchor(file_path, anchor, debug=False):
    """Check for either <a name="..."> or GitHub-style header slug."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            # Check for explicit anchor (supporting variants of <a name="...">)
            # Match <a name="anchor">, <a id="anchor">, etc.
            if f'name="{anchor}"' in content or f"name='{anchor}'" in content or f'id="{anchor}"' in content:
                return True
            # Check for headers
            for line in content.split('\n'):
                if line.startswith('#'):
                    # Strip leading # and whitespace
                    header_text = line.lstrip('#').strip()
                    slug = generate_github_slug(header_text)
                    if debug:
                        print(f"  [Anchor Check] Header: '{header_text}' -> Slug: '{slug}' (looking for: '{anchor}')")
                    if slug == anchor:
                        return True
                    if debug and anchor in slug:
                         print(f"DEBUG: Found partial match in {file_path}: header '{header_text}' -> slug '{slug}' vs anchor '{anchor}'")
            return False
    except Exception:
        return False

if __name__ == "__main__":
    search_path = sys.argv[1] if len(sys.argv) > 1 else '.'
    success = check_markdown_links(search_path)
    if not success:
        sys.exit(1)
