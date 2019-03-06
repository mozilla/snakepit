const cluster = require('cluster')
const Parallel = require('async-parallel')
const cpus = require('os').cpus().length
const log = require('./utils/logger.js')
const config = require('./config.js')
const models = require('./models')
const pitRunner = require('./pitRunner.js')
const scheduler = require('./scheduler.js')

async function startup () {
    await models.sequelize.sync()
    await Parallel.each(models.all, async model => await (model.startup || Function)())
    await pitRunner.startup()
    await scheduler.startup()
}

if (cluster.isMaster) {
    cluster.on('exit', (deadWorker, code, signal) => {
        if (code === 100) {
            process.exit(100) // Preventing fork-loop on startup problems
        }
        var worker = cluster.fork();
        log.error('Worker ' + deadWorker.process.pid + ' died.')
        log.info('Worker ' + worker.process.pid + ' born.')
    })
    startup().then(() => {
        for (let i = 0; i < cpus; i++) {
            cluster.fork()
        }
        log.info('Snakepit daemon started')
    }).catch(ex => {
        log.error('Snakepit startup problem:', ex)
        process.exit(1)
    })
} else {
    try {
        const http = require('http')
        const morgan = require('morgan')
        const express = require('express')
        const bodyParser = require('body-parser')

        let app = express()
        let expressWs = require('express-ws')(app)
        app.use(bodyParser.json({ limit: '50mb' }))
        app.use(morgan('combined', {
            skip: (req, res) => res.statusCode < 400 && !config.debugHttp
        }))
        
        app.use(require('./routes'))

        app.use((err, req, res, next) => {
            let message = err.message || 'Internal error'
            let code = err.code || 500
            log.error('ERROR', code, message)
            if (err.stack) {
                log.error(err.stack)
            }
            res.status(code).send({ message: message })
        })

        http.createServer(app).listen(config.port, config.interface)
        log.info('Snakepit service running on ' + config.interface + ':' + config.port)
    } catch (ex) {
        log.error('Failure during startup: ', ex, ex.stack)
        
        process.exit(100)
    }
}
