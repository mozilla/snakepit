const Router = require('express-promise-router')
const Alias = require('../models/Alias-model.js')

const { ensureSignedIn, ensureAdmin, tryTargetAlias, targetAlias } = require('./mw.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Alias.findAll()).map(alias => alias.id))
})

router.get('/:alias', targetAlias, async (req, res) => {
    res.send({
        id:     req.targetAlias.id,
        name:   req.targetAlias.name
    })
})

router.use(ensureAdmin)

router.put('/:alias', tryTargetAlias, async (req, res) => {
    if(req.targetAlias) {
        throw({ code: 400, message: 'Alias already exists' })
    }
    if (req.body && req.body.name) {
        await Alias.create({ id: req.params.alias, name: req.body.name })
        res.send()
    } else {
        res.status(400).send()
    }
})

router.delete('/:alias', targetAlias, async (req, res) => {
    req.targetAlias.destroy()
    res.send()
})
