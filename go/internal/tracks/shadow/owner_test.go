package shadow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckShadowOwnerRefusesASecondRepo(t *testing.T) {
	f := newFixture(t)
	other := filepath.Join(f.tmpDir, "other-repo")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	f.git(other, "init", "-q")
	shadow := filepath.Join(f.tmpDir, "shared.git")
	f.git(f.tmpDir, "init", "--bare", "-q", shadow)

	if err := checkShadowOwner(shadow, f.anchorRepo, true); err != nil {
		t.Fatalf("first repo should claim the shadow repo: %v", err)
	}
	err := checkShadowOwner(shadow, other, true)
	if err == nil || !strings.Contains(err.Error(), "belongs to") {
		t.Fatalf("second repo must be refused, got %v", err)
	}
	if err := checkShadowOwner(shadow, f.anchorRepo, true); err != nil {
		t.Fatalf("owner must keep working: %v", err)
	}
}

func TestCheckShadowOwnerReclaimsWhenOwnerDirIsGone(t *testing.T) {
	f := newFixture(t)
	gone := filepath.Join(f.tmpDir, "gone-repo")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	f.git(gone, "init", "-q")
	shadow := filepath.Join(f.tmpDir, "shared.git")
	f.git(f.tmpDir, "init", "--bare", "-q", shadow)
	if err := checkShadowOwner(shadow, gone, true); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	if err := checkShadowOwner(shadow, f.anchorRepo, true); err != nil {
		t.Fatalf("a shadow repo whose owner moved must be reclaimable: %v", err)
	}
}
