'use strict';

const { EventEmitter } = require('node:events');

// In-process fan-out for Server-Sent Events. MQTT remains the device transport.
const hub = new EventEmitter();
hub.setMaxListeners(0);

function emitData(type, data) {
  hub.emit('data', {
    type,
    at: new Date().toISOString(),
    data,
  });
}

module.exports = { hub, emitData };
