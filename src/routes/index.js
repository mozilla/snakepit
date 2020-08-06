const Router = require('express-promise-router')
const simplefs = require('../utils/simplefs.js')
const config = require('../config.js')

const sharedDir = '/data/shared'

var router = module.exports = new Router()

router.get('/hello', async (req, res) => {
    res.send('Here I am')
})

router.all('/shared/simplefs/' + simplefs.pattern, async (req, res) => {
    await simplefs.performCommand(sharedDir, req, res, true)
})

router.use('/users',   require('./users'))
router.use('/groups',  require('./groups'))
router.use('/jobs',    require('./jobs'))
router.use('/nodes',   require('./nodes'))
router.use('/aliases', require('./aliases'))
