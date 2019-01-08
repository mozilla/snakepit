const cluster = require('cluster')
const { EventEmitter } = require('events')

var emitter = module.exports = new EventEmitter()

let originalEmit = emitter.emit

function broadcast(message, ignore) {
    for(let wid in cluster.workers) {
        let worker = cluster.workers[wid]
        if (worker !== ignore) {
            worker.send(message)
        }
    }
}

if (cluster.isMaster) {
    cluster.on('fork', worker => {
        worker.on('message', message => {
            if (message.clusterEvent) {
                broadcast(message, worker)
            }
        })
    })
}

process.on('message', message => {
    if (message.clusterEvent) {
        originalEmit(message.clusterEvent, ...message.args)
    }
})

emitter.emit = function (clusterEvent, ...args) {
    originalEmit(clusterEvent, ...args)
    let message = {
        clusterEvent: clusterEvent,
        args: args
    }
    if (cluster.isMaster) {
        broadcast(message)
    } else {
        process.send(message)
    }
}
