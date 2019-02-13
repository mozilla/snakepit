const util = require('util')
const cluster = require('cluster')
const config = require('../config.js')

exports.debug = function (...args) {
    log(0, ...args)
}

exports.info = function (...args) {
    log(1, ...args)
}

exports.error = function (...args) {
    log(2, ...args)
}

if (cluster.isMaster) {
    cluster.on('fork', worker => {
        worker.on('message', msg => {
            if (msg.logMessage) {
                log(msg.level, msg.msg)
            }
        })
    })
}

function log (level, ...args) {
    if (level >= config.logLevel) {
        let msg = args.map(a => (typeof a == 'string') ? a : util.inspect(a)).join(' ')
        if (cluster.isMaster) {
            level >= 2 ? console.error(msg) : console.log(msg)
        } else {
            process.send({ logMessage: true, level: level, msg: msg })
        }
    }
}
