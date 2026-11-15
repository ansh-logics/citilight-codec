# CitiLight Streetlight Codec

A compact binary codec for a LoRaWAN streetlight controller. It encodes human-readable commands into small byte packets and decodes packets back into readable commands.

## Requirements coverage

The assignment lists seven commands. The four modes share one Set Mode command, so the codec uses five command IDs.

| Requirement | Command | Example packet |
|---|---|---|
| 1. On/Off | `0x01` On/Off | `01 01` (on) |
| 2. Dimming | `0x02` Dimming | `02 32` (50%) |
| 3. Always On Mode | `0x03` Set Mode, value `1` | `03 01` |
| 4. Always Off Mode | `0x03` Set Mode, value `0` | `03 00` |
| 5. Schedule Mode | `0x03` Set Mode, value `2` | `03 02` |
| 6. ALS Mode | `0x03` Set Mode, value `3`, thresholds via `0x04` Configure ALS | `03 03`, `04 14 1E` |
| 7. Set Schedule | `0x05` Set Schedule | `05 11 1E 00 6C 64 8A 32` |
| Bonus: ChirpStack codec | `encodeDownlink` / `decodeUplink` | see [ChirpStack](#chirpstack) |

All packets fit the IN865 limit of 51 bytes at the slowest data rate (DR0).

## Design goals

- **Fit the worst case.** Every packet fits the IN865 limit at the slowest data rate (DR0, SF12/125 kHz): **51 bytes** of application payload. Far-away streetlights run at DR0, so the codec is sized for them.
- **Every byte counts.** Smaller packets mean less airtime, fewer collisions and faster city-wide updates, especially for downlinks, where one gateway serves many lights.
- **Validate early.** The encoder rejects invalid input so bad packets never waste airtime. The decoder also validates, so corrupted packets fail safely instead of crashing.

## Packet structure

Every packet starts with a **command ID byte**. A command ID byte (instead of a separate FPort per command) costs one byte but keeps the format simple and lets the device identify any packet from its first byte.

Bytes are shown in hex. Decimal values are in brackets.

| ID | Command |
|---|---|
| `0x01` | On/Off |
| `0x02` | Dimming |
| `0x03` | Set Mode |
| `0x04` | Configure ALS |
| `0x05` | Set Schedule |

---

### 0x01 · On/Off

Manual override: turns the light on or off immediately.

| Byte | Field | Values |
|---|---|---|
| 0 | Command ID | `0x01` |
| 1 | Status | `0` = off, `1` = on |

**Example:** turn on → `01 01` [1, 1] · **Size:** 2 bytes

**Invalid:** status other than 0 or 1.

---

### 0x02 · Dimming

Sets the brightness level.

| Byte | Field | Values |
|---|---|---|
| 0 | Command ID | `0x02` |
| 1 | Level | 0–100 (%) → `0x00`–`0x64` |

**Example:** 50% → `02 32` [2, 50] · **Size:** 2 bytes

**Invalid:** level below 0, above 100, or not a whole number.

---

### 0x03 · Set Mode

Switches the operating mode. One command with a mode byte (instead of a separate command per mode) groups related behaviour and makes adding a new mode as simple as adding a new value.

| Byte | Field | Values |
|---|---|---|
| 0 | Command ID | `0x03` |
| 1 | Mode | `0` = Always Off, `1` = Always On, `2` = Schedule, `3` = ALS |

**Example:** Schedule mode → `03 02` [3, 2] · **Size:** 2 bytes

**Invalid:** mode value above 3.

---

### 0x04 · Configure ALS

Sets the ambient light sensor (ALS) thresholds. Kept separate from Set Mode so thresholds can be changed (for example, seasonally) without switching modes.

ALS uses **hysteresis**: the light turns on below the ON threshold and off only above the OFF threshold. Between the two it keeps its current state, which prevents flicker when light levels wobble around dusk.

| Byte | Field | Values |
|---|---|---|
| 0 | Command ID | `0x04` |
| 1 | ON threshold | lux ÷ 2 (0–510 lux) |
| 2 | OFF threshold | lux ÷ 2 (0–510 lux) |

Lux is scaled by 2 so values up to 510 lux fit in one byte, at a precision of 2 lux. Streetlights switch around 10–100 lux, so this precision is more than enough.

**Example:** ON at 40 lux, OFF at 60 lux → `04 14 1E` [4, 20, 30] · **Size:** 3 bytes

**Invalid:** lux below 0 or above 510; ON threshold not lower than OFF threshold (a reversed or equal pair would break hysteresis).

---

### 0x05 · Set Schedule

Sends a list of time slots. Each slot has a start time and a dimming level.

| Byte | Field | Values |
|---|---|---|
| 0 | Command ID | `0x05` |
| 1 | Part info | high nibble = part number (1–15), low nibble = total parts (1–15) |
| 2 | Slot 1 time | 10-minute steps since midnight, 0–143 (`0x00`–`0x8F`) = 00:00–23:50 |
| 3 | Slot 1 level | 0–100 (`0x00`–`0x64`) |
| … | … | up to 24 slots per packet |

**Size:** 2 + 2 × slots. Maximum 24 slots = 50 bytes, within the 51-byte limit.

**Time encoding:** `(hours × 60 + minutes) ÷ 10`, floored. Street lighting does not need minute precision, and one byte per time halves the slot size compared with exact minutes. Example: 18:00 → 108 → `0x6C`.

**Part info:** both values fit in one byte (one hex digit each), so it reads directly: `11` = part 1 of 1, `12` = part 1 of 2, `22` = part 2 of 2.

**Example:** 18:00 → 100%, 23:00 → 50%, 05:00 → 0%

| Bytes | Meaning |
|---|---|
| `05` | Set Schedule |
| `11` | Part 1 of 1 |
| `6C 64` | 18:00 → 100% |
| `8A 32` | 23:00 → 50% |
| `1E 00` | 05:00 → 0% |

Full packet: `05 11 6C 64 8A 32 1E 00` · **Size:** 9 bytes

**Encoder rules:**
- Times not on a 10-minute step are floored (18:07 → 18:00). Flooring never overflows past 23:50.
- Slots are sorted by time automatically.
- Rejected: time outside 00:00–23:59, level outside 0–100, 0 slots or more than 24 per packet, duplicate times (checked after flooring), part number 0, part number above total, total above 15.

**Decoder rules:**
- Packet length must be even (2 header bytes + complete 2-byte slots).
- Time step above 143 or level above 100 returns an error.

**Multi-part schedules:** the device keeps its old schedule until all parts arrive, then switches atomically. If a part is missing, it requests a resend. This means a street is never left running half a schedule.

## Running

```bash
npm test
```
