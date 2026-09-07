// Package glob provides the shared glob dialect ported from src/glob.ts:
// `*` (anything except `/`), `?` (exactly one character except `/`), `**`
// (anything including `/`, i.e. any depth) and `[...]`/`[!...]` character
// classes.
//
// The matcher is hand-written and operates on runes rather than delegating
// to `regexp`. That is deliberate: the TypeScript original built a RegExp
// source string, and JS's non-`u`-flagged RegExp matches `?`/`[^/]` against
// a single UTF-16 code unit, so a non-BMP filename character (an emoji, a
// CJK Extension-B ideograph) counts as TWO characters there and as ONE
// here. A literal translation of the regex approach would therefore have
// silently diverged from a rune-based engine; matching runes directly makes
// "one character" mean one Unicode code point on both sides.
package glob

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HasGlobMeta reports whether pattern contains any glob metacharacter
// (`*`, `?`, `[`). A pattern without one is a literal path.
func HasGlobMeta(pattern string) bool {
	return strings.ContainsAny(pattern, "*?[")
}

// Match reports whether the slash-separated path value matches pattern
// under the dialect documented on the package. It is the counterpart of
// src/glob.ts's globToRegExp(...).test(...) and is used both to filter a
// filesystem walk (ExpandUnderRoot) and to filter existing manifest
// entries, which may name paths that no longer exist on disk.
func Match(pattern, value string) bool {
	return matchTokens(compile(pattern), []rune(value), 0, 0)
}

// ExpandUnderRoot expands pattern against every regular file's path
// (relative to root, slash-separated) found by walking the filesystem
// starting at root, and returns the sorted list of matches.
//
// The walk is confined to real, non-symlinked directories: every entry is
// lstat-ed before being recursed into or collected, so a symlinked
// directory component is never descended into and a symlinked file is
// never collected. Only regular files can match — never directories.
func ExpandUnderRoot(root, pattern string) ([]string, error) {
	if _, err := os.ReadDir(root); err != nil {
		return nil, err
	}

	var all []string
	walkFiles(root, "", &all)

	tokens := compile(pattern)
	matches := make([]string, 0, len(all))
	for _, rel := range all {
		if matchTokens(tokens, []rune(rel), 0, 0) {
			matches = append(matches, rel)
		}
	}
	sort.Strings(matches)
	return matches, nil
}

// walkFiles recursively collects every regular file's path (relative to
// root, slash-separated) under root/relDir. Unreadable directories and
// unstattable entries are skipped rather than aborting the walk, matching
// the TypeScript original.
func walkFiles(root, relDir string, out *[]string) {
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(relDir)))
	if err != nil {
		return
	}

	for _, entry := range entries {
		entryRel := entry.Name()
		if relDir != "" {
			entryRel = relDir + "/" + entry.Name()
		}

		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(entryRel)))
		if err != nil {
			continue
		}

		switch {
		case info.Mode()&os.ModeSymlink != 0:
			continue
		case info.IsDir():
			walkFiles(root, entryRel, out)
		case info.Mode().IsRegular():
			*out = append(*out, entryRel)
		}
	}
}

type tokenKind int

const (
	tokLiteral       tokenKind = iota
	tokAny                     // ?          — one rune, not `/`
	tokStar                    // *          — zero+ runes, none of them `/`
	tokGlobStar                // **         — zero+ runes, `/` included
	tokGlobStarSlash           // **/        — empty, or any run of runes ending in `/`
	tokClass                   // [...] / [!...]
)

type classRange struct {
	lo, hi rune
}

type token struct {
	kind   tokenKind
	ch     rune
	negate bool
	ranges []classRange
}

// compile splits pattern into matcher tokens. `**` immediately followed by
// `/` collapses into a single tokGlobStarSlash so that "plans/**/*.md" also
// matches "plans/a.md" (zero intervening directories).
func compile(pattern string) []token {
	runes := []rune(pattern)
	tokens := make([]token, 0, len(runes))

	for i := 0; i < len(runes); {
		switch c := runes[i]; {
		case c == '*' && i+1 < len(runes) && runes[i+1] == '*':
			if i+2 < len(runes) && runes[i+2] == '/' {
				tokens = append(tokens, token{kind: tokGlobStarSlash})
				i += 3
			} else {
				tokens = append(tokens, token{kind: tokGlobStar})
				i += 2
			}
		case c == '*':
			tokens = append(tokens, token{kind: tokStar})
			i++
		case c == '?':
			tokens = append(tokens, token{kind: tokAny})
			i++
		case c == '[':
			tok, next := compileClass(runes, i)
			tokens = append(tokens, tok)
			i = next
		default:
			tokens = append(tokens, token{kind: tokLiteral, ch: c})
			i++
		}
	}

	return tokens
}

// compileClass parses the `[...]` class starting at runes[start] (which is
// `[`) and returns the token plus the index just past the closing `]`. A
// leading `!` or `^` negates. Inside the class, `a-z` is a range; a `-`
// with no rune on both sides is a literal. An unterminated class consumes
// the rest of the pattern.
func compileClass(runes []rune, start int) (token, int) {
	i := start + 1
	tok := token{kind: tokClass}

	if i < len(runes) && (runes[i] == '!' || runes[i] == '^') {
		tok.negate = true
		i++
	}

	for i < len(runes) && runes[i] != ']' {
		if i+2 < len(runes) && runes[i+1] == '-' && runes[i+2] != ']' {
			tok.ranges = append(tok.ranges, classRange{lo: runes[i], hi: runes[i+2]})
			i += 3
			continue
		}
		tok.ranges = append(tok.ranges, classRange{lo: runes[i], hi: runes[i]})
		i++
	}

	if i < len(runes) {
		i++ // consume the closing `]`
	}
	return tok, i
}

func (t token) classMatches(r rune) bool {
	inSet := false
	for _, cr := range t.ranges {
		if r >= cr.lo && r <= cr.hi {
			inSet = true
			break
		}
	}
	return inSet != t.negate
}

// matchTokens anchors tokens[ti:] against s[si:], backtracking over the
// wildcard tokens. Every advance consumes exactly one rune, so `?` and a
// character class each match one Unicode code point regardless of how many
// bytes or UTF-16 code units encode it.
func matchTokens(tokens []token, s []rune, ti, si int) bool {
	for {
		if ti == len(tokens) {
			return si == len(s)
		}

		tok := tokens[ti]
		switch tok.kind {
		case tokLiteral:
			if si >= len(s) || s[si] != tok.ch {
				return false
			}
			ti++
			si++

		case tokAny:
			if si >= len(s) || s[si] == '/' {
				return false
			}
			ti++
			si++

		case tokClass:
			if si >= len(s) || !tok.classMatches(s[si]) {
				return false
			}
			ti++
			si++

		case tokStar:
			for k := si; ; k++ {
				if matchTokens(tokens, s, ti+1, k) {
					return true
				}
				if k >= len(s) || s[k] == '/' {
					return false
				}
			}

		case tokGlobStar:
			for k := si; k <= len(s); k++ {
				if matchTokens(tokens, s, ti+1, k) {
					return true
				}
			}
			return false

		case tokGlobStarSlash:
			if matchTokens(tokens, s, ti+1, si) {
				return true
			}
			for k := si; k < len(s); k++ {
				if s[k] == '/' && matchTokens(tokens, s, ti+1, k+1) {
					return true
				}
			}
			return false
		}
	}
}
