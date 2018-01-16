const cluster = require('cluster')

var numReqs = 0
var worker

if (cluster.isMaster) {
    // Fork workers.
    for (var i = 0; i < 2; i++) {
        worker = cluster.fork()
        store.registerWorker(worker)
    }
} else {
    store.registerWorker(process)

    const express = require('express')
    const app = express()

    app.get('/now', function(req, res) {
        res.status(200).send({ date: new Date() })
        process.send({ chat: 'Hey master, I got a new now request!' })
    })

    // Bind to a port
    var port = process.env.PORT || 1337
    app.listen(port)
    console.log('Worker running on port ' + port)

}