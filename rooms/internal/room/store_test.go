package room_test

import (
	"testing"

	"github.com/zerkerlabs/gateway/rooms/internal/room"
	"github.com/zerkerlabs/gateway/rooms/internal/room/roomtest"
)

func TestMemoryStore_Contract(t *testing.T) {
	t.Parallel()

	roomtest.RunContract(t, func() room.Store {
		return room.NewMemoryStore()
	})
}
