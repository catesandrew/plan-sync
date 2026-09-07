// Package args provides shared CLI argument-parsing helpers ported from
// src/args.ts, matching its flag semantics exactly (byte-for-byte behavior
// is not required here, only structural/decision parity).
package args

import "fmt"

// Track mirrors src/args.ts's Track union type.
type Track string

const (
	TrackSibling Track = "sibling"
	TrackShadow  Track = "shadow"
)

var validTracks = []Track{TrackSibling, TrackShadow}

// HasHelpFlag reports whether --help or -h appears anywhere in args.
// Commands must call this FIRST, before any other flag parsing, so --help
// works regardless of position and never triggers real side effects.
func HasHelpFlag(args []string) bool {
	for _, a := range args {
		if a == "--help" || a == "-h" {
			return true
		}
	}
	return false
}

// ParseTrack parses "--track <sibling|shadow>" (or "--track=<value>") out of
// args. When --track isn't given and defaultTrack is non-empty, falls back
// to defaultTrack instead of erroring. An explicit --track always overrides
// the default.
func ParseTrack(args []string, defaultTrack Track) (track Track, rest []string, err error) {
	var found string
	hasFound := false

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--track":
			if i+1 < len(args) {
				found = args[i+1]
				hasFound = true
			}
			i++
		case len(a) >= len("--track=") && a[:len("--track=")] == "--track=":
			found = a[len("--track="):]
			hasFound = true
		default:
			rest = append(rest, a)
		}
	}

	if !hasFound && defaultTrack != "" {
		return defaultTrack, rest, nil
	}

	if !hasFound || !isValidTrack(found) {
		got := found
		if !hasFound {
			got = "<none>"
		}
		return "", nil, fmt.Errorf("--track is required and must be one of: sibling, shadow (got: %s)", got)
	}

	return Track(found), rest, nil
}

func isValidTrack(s string) bool {
	for _, t := range validTracks {
		if string(t) == s {
			return true
		}
	}
	return false
}

// ParseFlag parses "--<name> <value>" (or "--<name>=<value>") out of args,
// returning the value (empty string if not present) and the remaining args
// with that flag/value removed.
func ParseFlag(args []string, name string) (value string, rest []string) {
	flag := "--" + name
	prefix := flag + "="

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == flag:
			if i+1 < len(args) {
				value = args[i+1]
			}
			i++
		case len(a) >= len(prefix) && a[:len(prefix)] == prefix:
			value = a[len(prefix):]
		default:
			rest = append(rest, a)
		}
	}

	return value, rest
}
