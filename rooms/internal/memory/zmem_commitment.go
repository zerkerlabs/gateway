package memory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"unicode/utf16"
)

// commitmentDigestField is the field a backend's commitment object carries
// its self-attesting digest under. It is excluded from the bytes that get
// hashed: a commitment attests to everything about a prepared context
// except its own signature.
const commitmentDigestField = "room_context_digest"

// digestPattern matches the "sha256:<64 lowercase hex>" shape every digest
// in this contract uses.
var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// verifyCommitment recomputes a commitment's digest from raw — the exact
// bytes a backend returned for a contexts:prepare response's "commitment"
// field — and checks it against the digest the commitment itself carries.
// It fails closed: raw that does not decode to a JSON object, a missing or
// malformed digest field, and a digest that does not match the
// recomputation are all errors, never warnings. On success it returns the
// verified digest.
//
// The backend computes its digest as
// sha256(canonical_json(commitment minus its digest field)), where
// canonical JSON is Python's json.dumps(value, sort_keys=True,
// separators=(",", ":")). See canonicalJSON for the byte-for-byte
// reproduction of that this client depends on.
func verifyCommitment(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("memory: commitment is absent")
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var decoded any
	if err := dec.Decode(&decoded); err != nil {
		return "", fmt.Errorf("memory: decode commitment: %w", err)
	}

	obj, ok := decoded.(map[string]any)
	if !ok {
		return "", errors.New("memory: commitment is not a JSON object")
	}

	digestVal, ok := obj[commitmentDigestField]
	if !ok {
		return "", fmt.Errorf("memory: commitment has no %s field", commitmentDigestField)
	}
	digest, ok := digestVal.(string)
	if !ok || !digestPattern.MatchString(digest) {
		return "", fmt.Errorf("memory: commitment %s is malformed: %v", commitmentDigestField, digestVal)
	}

	stripped := make(map[string]any, len(obj)-1)
	for k, v := range obj {
		if k != commitmentDigestField {
			stripped[k] = v
		}
	}
	canonical, err := canonicalJSON(stripped)
	if err != nil {
		return "", fmt.Errorf("memory: canonicalize commitment: %w", err)
	}
	sum := sha256.Sum256(canonical)
	want := "sha256:" + hex.EncodeToString(sum[:])
	if digest != want {
		return "", fmt.Errorf("memory: commitment digest mismatch: got %s want %s", digest, want)
	}
	return digest, nil
}

// canonicalJSON renders v — decoded from JSON with json.Number preserved so
// integers round-trip exactly — into the precise byte sequence Python's
// json.dumps(v, sort_keys=True, separators=(",", ":")) would produce:
// object keys sorted, no insignificant whitespace, every rune outside the
// printable ASCII range 0x20-0x7E escaped to \uXXXX (Python's
// ensure_ascii=True default, which Go's encoder does not replicate), and
// none of '<', '>', '&' escaped
// (encoding/json's default HTML-escaping, which Python's encoder has no
// equivalent of). A client verifying a backend's commitment must reproduce
// these bytes exactly, or a correct digest reads as a mismatch — see the
// golden vectors in zmem_test.go, which pin this function against
// hand-verified output rather than relying on this file's own correctness.
func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch val := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if val {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		buf.WriteString(string(val))
	case string:
		writeCanonicalString(buf, val)
	case map[string]any:
		return writeCanonicalObject(buf, val)
	case []any:
		buf.WriteByte('[')
		for i, e := range val {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		return fmt.Errorf("memory: canonicalJSON: unsupported type %T", v)
	}
	return nil
}

func writeCanonicalObject(buf *bytes.Buffer, obj map[string]any) error {
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	buf.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		writeCanonicalString(buf, k)
		buf.WriteByte(':')
		if err := writeCanonical(buf, obj[k]); err != nil {
			return err
		}
	}
	buf.WriteByte('}')
	return nil
}

// writeCanonicalString escapes s the way Python's json.dumps does with its
// defaults: '"' and '\\' get their short escapes, the standard single-letter
// control-character escapes are used where they apply, and every other rune
// outside the printable ASCII range 0x20-0x7E — including U+007F (DEL) and
// everything at or above U+0080 — becomes \uXXXX, a surrogate pair for runes
// above the Basic Multilingual Plane. Nothing else is escaped: unlike
// encoding/json's default, '<', '>', and '&' pass through unescaped, because
// Python's encoder never touches them.
func writeCanonicalString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(buf, `\u%04x`, r)
			case r < 0x7F:
				buf.WriteRune(r)
			case r <= 0xFFFF:
				fmt.Fprintf(buf, `\u%04x`, r)
			default:
				r1, r2 := utf16.EncodeRune(r)
				fmt.Fprintf(buf, `\u%04x\u%04x`, r1, r2)
			}
		}
	}
	buf.WriteByte('"')
}
