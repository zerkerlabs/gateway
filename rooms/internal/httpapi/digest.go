package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
)

// membershipDigest and roomStateDigest bind a memory-preparation request's
// commitment to the exact room state that asked for it — without them a
// returned commitment still verifies, but only attests "a context was
// prepared," not "prepared for this room, in this state." Both definitions
// are contract, not implementation detail: changing either one changes every
// digest computed against it, which makes every commitment issued under the
// old definition unreproducible.

// membershipDigest returns a "sha256:<64 lowercase hex>" digest over
// members' agent IDs, lexically sorted and NUL-separated before hashing.
// Sorting makes the digest independent of the order members happen to sit in
// a slice; the NUL separator keeps two different member sets from ever
// hashing identically by plain concatenation (e.g. {"ab", "c"} vs. {"a",
// "bc"}).
func membershipDigest(members []*room.Member) string {
	ids := make([]string, len(members))
	for i, m := range members {
		ids[i] = m.AgentID
	}
	sort.Strings(ids)
	return sha256Digest(ids...)
}

// roomStateDigest returns a "sha256:<64 lowercase hex>" digest over the
// room's lifecycle state, its event count, and its last event's sequence
// number (0 for a room with no events yet), NUL-separated before hashing.
func roomStateDigest(r *room.Room) string {
	lastEventID := 0
	if n := len(r.Events); n > 0 {
		lastEventID = r.Events[n-1].Sequence
	}
	return sha256Digest(string(r.State), strconv.Itoa(len(r.Events)), strconv.Itoa(lastEventID))
}

// sha256Digest hashes parts NUL-separated and formats the sum as
// "sha256:<64 lowercase hex>", the format a real memory backend validates
// and rejects anything else.
func sha256Digest(parts ...string) string {
	h := sha256.New()
	for i, p := range parts {
		if i > 0 {
			h.Write([]byte{0})
		}
		h.Write([]byte(p))
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}
