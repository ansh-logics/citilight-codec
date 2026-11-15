const CMD = {
  ON_OFF: 0x01,
  DIMMING: 0x02,
  SET_MODE: 0x03,
  CONFIGURE_ALS: 0x04,
  SET_SCHEDULE: 0x05,
};

const MODES = ["always_off", "always_on", "schedule", "als"];

function timeToStep(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time format: ${time}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time: ${time}`);

  return Math.floor((hours * 60 + minutes) / 10);
}

function stepToTime(step) {
  if (step > 143) throw new Error(`Invalid time step: ${step}`);

  const totalMinutes = step * 10;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function checkRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}, got: ${value}`);
  }
}

function encodeSchedule(cmd) {
  const part = cmd.part ?? 1;
  const totalParts = cmd.totalParts ?? 1;
  checkRange(totalParts, 1, 15, "totalParts");
  checkRange(part, 1, totalParts, "part");

  if (!Array.isArray(cmd.slots) || cmd.slots.length < 1 || cmd.slots.length > 24) {
    throw new Error("slots must be a list of 1 to 24 entries");
  }

  const slots = cmd.slots
    .map((slot) => {
      checkRange(slot.level, 0, 100, "level");
      return { step: timeToStep(slot.time), level: slot.level };
    })
    .sort((a, b) => a.step - b.step);

  for (let i = 1; i < slots.length; i++) {
    if (slots[i].step === slots[i - 1].step) {
      throw new Error(`Duplicate slot time: ${stepToTime(slots[i].step)}`);
    }
  }

  const bytes = [CMD.SET_SCHEDULE, part * 16 + totalParts];
  for (const slot of slots) bytes.push(slot.step, slot.level);
  return bytes;
}

function encodeCommand(cmd) {
  switch (cmd.command) {
    case "on_off":
      if (typeof cmd.on !== "boolean") throw new Error("on must be true or false");
      return [CMD.ON_OFF, cmd.on ? 1 : 0];

    case "dimming":
      checkRange(cmd.level, 0, 100, "level");
      return [CMD.DIMMING, cmd.level];

    case "set_mode": {
      const mode = MODES.indexOf(cmd.mode);
      if (mode === -1) throw new Error(`Unknown mode: ${cmd.mode}`);
      return [CMD.SET_MODE, mode];
    }

    case "configure_als": {
      checkRange(cmd.onLux, 0, 510, "onLux");
      checkRange(cmd.offLux, 0, 510, "offLux");
      const onByte = Math.floor(cmd.onLux / 2);
      const offByte = Math.floor(cmd.offLux / 2);
      if (onByte >= offByte) throw new Error("onLux must be at least 2 lux lower than offLux");
      return [CMD.CONFIGURE_ALS, onByte, offByte];
    }

    case "set_schedule":
      return encodeSchedule(cmd);

    default:
      throw new Error(`Unknown command: ${cmd.command}`);
  }
}
function expectLength(bytes, length) {
  if (bytes.length !== length) {
    throw new Error(`Expected ${length} bytes, got ${bytes.length}`);
  }
}

function decodeSchedule(bytes) {
  if (bytes.length < 4 || bytes.length > 50 || bytes.length % 2 !== 0) {
    throw new Error(`Invalid schedule packet length: ${bytes.length}`);
  }

  const part = Math.floor(bytes[1] / 16);
  const totalParts = bytes[1] % 16;
  if (totalParts < 1 || part < 1 || part > totalParts) {
    throw new Error(`Invalid part info: ${part} of ${totalParts}`);
  }

  const slots = [];
  for (let i = 2; i < bytes.length; i += 2) {
    checkRange(bytes[i + 1], 0, 100, "level");
    slots.push({ time: stepToTime(bytes[i]), level: bytes[i + 1] });
  }

  return { command: "set_schedule", part, totalParts, slots };
}

function decodeCommand(bytes) {
  if (!bytes || bytes.length < 1) throw new Error("Empty packet");

  switch (bytes[0]) {
    case CMD.ON_OFF:
      expectLength(bytes, 2);
      if (bytes[1] > 1) throw new Error(`Invalid on/off status: ${bytes[1]}`);
      return { command: "on_off", on: bytes[1] === 1 };

    case CMD.DIMMING:
      expectLength(bytes, 2);
      checkRange(bytes[1], 0, 100, "level");
      return { command: "dimming", level: bytes[1] };

    case CMD.SET_MODE:
      expectLength(bytes, 2);
      if (bytes[1] >= MODES.length) throw new Error(`Invalid mode: ${bytes[1]}`);
      return { command: "set_mode", mode: MODES[bytes[1]] };

    case CMD.CONFIGURE_ALS:
      expectLength(bytes, 3);
      if (bytes[1] >= bytes[2]) throw new Error("ON threshold must be lower than OFF threshold");
      return { command: "configure_als", onLux: bytes[1] * 2, offLux: bytes[2] * 2 };

    case CMD.SET_SCHEDULE:
      return decodeSchedule(bytes);

    default:
      throw new Error(`Unknown command ID: ${bytes[0]}`);
  }
}
const UPLINK = { STATUS: 0x81 };

function encodeStatus(status) {
  const mode = MODES.indexOf(status.mode);
  if (mode === -1) throw new Error(`Unknown mode: ${status.mode}`);
  checkRange(status.level, 0, 100, "level");
  checkRange(status.powerWatts, 0, 65535, "powerWatts");
  return [UPLINK.STATUS, mode, status.level, Math.floor(status.powerWatts / 256), status.powerWatts % 256];
}

function decodeStatus(bytes) {
  expectLength(bytes, 5);
  if (bytes[1] >= MODES.length) throw new Error(`Invalid mode: ${bytes[1]}`);
  checkRange(bytes[2], 0, 100, "level");
  return {
    type: "status",
    mode: MODES[bytes[1]],
    level: bytes[2],
    powerWatts: bytes[3] * 256 + bytes[4],
  };
}

function decodeUplink(input) {
  const bytes = input.bytes;
  if (!bytes || bytes.length < 1) throw new Error("Empty uplink");
  if (bytes[0] === UPLINK.STATUS) return { data: decodeStatus(bytes) };
  throw new Error(`Unknown uplink type: ${bytes[0]}`);
}

function encodeDownlink(input) {
  return { bytes: encodeCommand(input.data), fPort: 10 };
}

if (typeof module !== "undefined") {
  module.exports = { CMD, MODES, timeToStep, stepToTime, encodeCommand, decodeCommand, encodeStatus, decodeUplink, encodeDownlink };
}