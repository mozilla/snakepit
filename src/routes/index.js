const Router = require('express-promise-router')
const fslib = require('../utils/httpfs.js')
const config = require('../config.js')

var router = module.exports = new Router()

router.get('/hello', async (req, res) => {
    res.send('Here I am')
})

router.post('/shared', async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.readOnly(fslib.real('/data/shared')), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})

router.use('/users',   require('./users'))
router.use('/groups',  require('./groups'))
router.use('/jobs',    require('./jobs'))
router.use('/nodes',   require('./nodes'))
router.use('/aliases', require('./aliases'))
