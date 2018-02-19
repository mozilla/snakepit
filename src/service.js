const cluster = require('cluster')
const db = require('./store.js').root
const cpus = require('os').cpus().length

const modules = 'user node'.split(' ').map(name => require('./' + name + '.js'))

if (cluster.isMaster) {
    for (var i = 0; i < cpus; i++)
        cluster.fork()
    modules.forEach(module => module.initDb(db))
} else {
    const express = require('express')
    const app = express()

    modules.forEach(module => module.initApp(app, db))

    var port = process.env.SNAKEPIT_PORT || 1337
    app.listen(port)
    console.log('Worker running on port ' + port)
}
