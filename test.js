const { encodeCommand } = require("./codec");

const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

console.log(toHex(encodeCommand({ command: "on_off", on: true })));
console.log(toHex(encodeCommand({ command: "dimming", level: 50 })));
console.log(toHex(encodeCommand({ command: "set_mode", mode: "schedule" })));
console.log(toHex(encodeCommand({ command: "configure_als", onLux: 40, offLux: 60 })));
console.log(toHex(encodeCommand({
    command: "set_schedule",
    slots: [
        { time: "23:00", level: 50 },
        { time: "18:00", level: 100 },
        { time: "05:00", level: 0 },
    ],
})));