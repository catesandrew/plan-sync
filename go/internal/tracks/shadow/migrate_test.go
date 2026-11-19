package shadow

import (
	"os"
	"strings"
	"testing"

	"plan-sync/go/internal/shadowpaths"
)

// twoRootAnchor turns the fixture's anchor repo into a two-root repo, so its
// current project id differs from the legacy (smallest-root) id.
func twoRootAnchor(t *testing.T, f *fixture) {
	t.Helper()
	branch := strings.TrimSpace(f.git(f.anchorRepo, "rev-parse", "--abbrev-ref", "HEAD"))
	f.git(f.anchorRepo, "checkout", "-q", "--orphan", "other")
	f.git(f.anchorRepo, "rm", "-q", "-rf", ".")
	f.git(f.anchorRepo, "commit", "-q", "--allow-empty", "-m", "other root")
	f.git(f.anchorRepo, "checkout", "-q", branch)
	f.git(f.anchorRepo, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "other")
}

// seedLegacyShadow builds a shadow repo as the old tool left it: legacy path,
// legacy ref, pushed to origin.
func seedLegacyShadow(t *testing.T, f *fixture) (legacyPath, legacyTip string) {
	t.Helper()
	legacy, err := shadowpaths.ResolveLegacyProjectId(f.anchorRepo)
	if err != nil {
		t.Fatalf("ResolveLegacyProjectId: %v", err)
	}
	legacyPath, err = shadowpaths.ResolveShadowRepoPath(legacy, ".omc")
	if err != nil {
		t.Fatalf("ResolveShadowRepoPath: %v", err)
	}
	ref, err := shadowpaths.ResolveShadowRefName(legacy, ".omc")
	if err != nil {
		t.Fatalf("ResolveShadowRefName: %v", err)
	}
	if err := os.MkdirAll(legacyPath, 0o755); err != nil {
		t.Fatal(err)
	}
	f.git(f.tmpDir, "init", "--bare", "-q", legacyPath)
	g := "--git-dir=" + legacyPath
	f.commitFixtureTree(legacyPath, ref, map[string]string{"a.md": "v1\n"})
	f.git(f.anchorRepo, g, "push", f.originRemote, ref+":"+ref)
	return legacyPath, strings.TrimSpace(f.git(f.anchorRepo, g, "rev-parse", ref))
}

func TestAdoptLegacyShadowSeedsNewIdFromOriginsLegacyRef(t *testing.T) {
	f := newFixture(t)
	twoRootAnchor(t, f)
	legacyPath, legacyTip := seedLegacyShadow(t, f)

	if err := adoptLegacyShadow(f.anchorRepo, ".omc"); err != nil {
		t.Fatalf("adoptLegacyShadow: %v", err)
	}

	id, _ := shadowpaths.ResolveProjectId(f.anchorRepo)
	newPath, _ := shadowpaths.ResolveShadowRepoPath(id, ".omc")
	newRef, _ := shadowpaths.ResolveShadowRefName(id, ".omc")
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("expected a shadow repo at the new id's path %s: %v", newPath, err)
	}
	got := strings.TrimSpace(f.git(f.anchorRepo, "--git-dir="+newPath, "rev-parse", newRef))
	if got != legacyTip {
		t.Errorf("new ref = %s, want the origin's legacy tip %s", got, legacyTip)
	}
	if _, err := os.Stat(legacyPath); err != nil {
		t.Errorf("legacy dir must be left untouched (a sibling may share it): %v", err)
	}
}

func TestAdoptLegacyShadowDoesNothingWhenNeverInitialisedUnderLegacyId(t *testing.T) {
	f := newFixture(t)
	twoRootAnchor(t, f)

	if err := adoptLegacyShadow(f.anchorRepo, ".omc"); err != nil {
		t.Fatalf("adoptLegacyShadow: %v", err)
	}

	id, _ := shadowpaths.ResolveProjectId(f.anchorRepo)
	newPath, _ := shadowpaths.ResolveShadowRepoPath(id, ".omc")
	if _, err := os.Stat(newPath); err == nil {
		t.Errorf("did not expect a shadow repo at %s", newPath)
	}
}
