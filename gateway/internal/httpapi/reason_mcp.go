package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	reasonauth "github.com/zerkerlabs/gateway/gateway/internal/reason"
)

const reasonMCPEnvelopeSchema = "zerker.gateway.reason-mcp-call.v1"

var (
	errReasonMalformed = errors.New("malformed Reason MCP request")
	errReasonRequired  = errors.New("reason authorization required")
	errReasonMismatch  = errors.New("reason authorization does not match MCP call")
)

type reasonMCPAuthorization struct {
	RequestDigest         string
	ReasoningResultDigest string
}

type parsedMCPCall struct {
	body      []byte
	method    string
	tool      string
	arguments json.RawMessage
}

// enforceReasonMCP consumes one fully buffered transactional request. Ordinary
// non-tools/call MCP messages pass through unchanged. A tools/call must instead
// arrive in the v1 envelope; the exact captured authorization bytes are sent to
// Reason, and only verified+authorized output whose tool/arguments match the
// concrete call is accepted.
func enforceReasonMCP(ctx context.Context, verifier reasonauth.Verifier, body []byte) (parsedMCPCall, *reasonMCPAuthorization, error) {
	if err := validateUniqueJSON(body); err != nil {
		return parsedMCPCall{}, nil, fmt.Errorf("%w: %w", errReasonMalformed, err)
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil || top == nil {
		return parsedMCPCall{}, nil, errReasonMalformed
	}
	if _, enveloped := top["schema"]; !enveloped {
		call, err := parseMCPCall(body)
		if err != nil {
			return parsedMCPCall{}, nil, err
		}
		if call.method == "tools/call" {
			return parsedMCPCall{}, nil, errReasonRequired
		}
		return call, nil, nil
	}

	var envelope struct {
		Schema        string          `json:"schema"`
		Call          json.RawMessage `json:"call"`
		Authorization json.RawMessage `json:"authorization"`
	}
	if err := decodeExactJSON(body, &envelope); err != nil ||
		envelope.Schema != reasonMCPEnvelopeSchema || len(envelope.Call) == 0 || len(envelope.Authorization) == 0 {
		return parsedMCPCall{}, nil, errReasonMalformed
	}
	if err := validateUniqueJSON(envelope.Call); err != nil {
		return parsedMCPCall{}, nil, fmt.Errorf("%w: invalid call", errReasonMalformed)
	}
	if err := validateUniqueJSON(envelope.Authorization); err != nil {
		return parsedMCPCall{}, nil, fmt.Errorf("%w: invalid authorization", errReasonMalformed)
	}
	call, err := parseMCPCall(envelope.Call)
	if err != nil || call.method != "tools/call" {
		return parsedMCPCall{}, nil, errReasonMalformed
	}

	verification, err := verifier.Verify(ctx, envelope.Authorization)
	if err != nil {
		return parsedMCPCall{}, nil, err
	}

	var bundle struct {
		Schema  string `json:"schema"`
		Request struct {
			Schema string `json:"schema"`
			Action struct {
				Tool      string          `json:"tool"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"action"`
		} `json:"request"`
	}
	if err := json.Unmarshal(envelope.Authorization, &bundle); err != nil ||
		bundle.Schema != "zerker.reason.authorization-bundle.v1" ||
		bundle.Request.Schema != "zerker.reason.action.v1" || bundle.Request.Action.Tool == "" {
		return parsedMCPCall{}, nil, errReasonMalformed
	}

	actionArgs := bundle.Request.Action.Arguments
	if len(actionArgs) == 0 {
		actionArgs = json.RawMessage(`{}`)
	}
	callArgs := call.arguments
	if len(callArgs) == 0 {
		callArgs = json.RawMessage(`{}`)
	}
	expectedArgs, err := canonicalJSONObject(actionArgs)
	if err != nil {
		return parsedMCPCall{}, nil, errReasonMalformed
	}
	actualArgs, err := canonicalJSONObject(callArgs)
	if err != nil {
		return parsedMCPCall{}, nil, errReasonMalformed
	}
	if call.tool != bundle.Request.Action.Tool || !bytes.Equal(actualArgs, expectedArgs) {
		return parsedMCPCall{}, nil, errReasonMismatch
	}

	return call, &reasonMCPAuthorization{
		RequestDigest:         verification.RequestDigest,
		ReasoningResultDigest: verification.ReasoningResultDigest,
	}, nil
}

func parseMCPCall(body []byte) (parsedMCPCall, error) {
	var request struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &request); err != nil || request.JSONRPC != "2.0" || request.Method == "" {
		return parsedMCPCall{}, errReasonMalformed
	}
	call := parsedMCPCall{body: append([]byte(nil), body...), method: request.Method}
	if request.Method != "tools/call" {
		return call, nil
	}
	if !validJSONRPCID(request.ID) {
		return parsedMCPCall{}, errReasonMalformed
	}

	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if len(request.Params) == 0 || json.Unmarshal(request.Params, &params) != nil || params.Name == "" {
		return parsedMCPCall{}, errReasonMalformed
	}
	if len(params.Arguments) > 0 {
		if _, err := canonicalJSONObject(params.Arguments); err != nil {
			return parsedMCPCall{}, errReasonMalformed
		}
	}
	call.tool = params.Name
	call.arguments = params.Arguments
	return call, nil
}

func validJSONRPCID(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var id any
	if err := dec.Decode(&id); err != nil || requireDecoderEOF(dec) != nil {
		return false
	}
	switch id.(type) {
	case string, json.Number:
		return true
	default:
		return false
	}
}

func canonicalJSONObject(raw []byte) ([]byte, error) {
	if err := validateUniqueJSON(raw); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value map[string]any
	if err := dec.Decode(&value); err != nil || value == nil {
		return nil, errors.New("expected JSON object")
	}
	if err := requireDecoderEOF(dec); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func decodeExactJSON(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return requireDecoderEOF(dec)
}

func requireDecoderEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

// validateUniqueJSON rejects duplicate object keys at every depth. Both Go and
// Rust JSON decoders otherwise keep one duplicate value; rejecting ambiguity is
// necessary before comparing the call Gateway forwards with the action Reason
// verified.
func validateUniqueJSON(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := consumeUniqueJSONValue(dec); err != nil {
		return err
	}
	return requireDecoderEOF(dec)
}

func consumeUniqueJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate object key %q", key)
			}
			seen[key] = struct{}{}
			if err := consumeUniqueJSONValue(dec); err != nil {
				return err
			}
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for dec.More() {
			if err := consumeUniqueJSONValue(dec); err != nil {
				return err
			}
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}
