const Router = require('express-promise-router')
const Alias = require('../models/Alias-model.js')

const { ensureSignedIn, ensureAdmin } = require('./users.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Alias.findAll()).map(alias => alias.id))
})

function targetAlias (req, res, next) {
    Alias.findByPk(req.params.id).then(alias => {
        if (alias) {
            req.targetAlias = alias
            next()
        } else {
            res.status(404).send()
        }
    })
}

router.get('/:id', targetAlias, async (req, res) => {
    res.send({
        id:     req.targetAlias.id,
        name:   req.targetAlias.name
    })
})

router.use(ensureAdmin)

router.put('/:id', async (req, res) => {
    if (req.body && req.body.name) {
        await Alias.create({
            id:   req.params.id,
            name: req.body.name
        })
        res.send()
    } else {
        res.status(400).send()
    }
})

router.delete('/:id', targetAlias, async (req, res) => {
    req.targetAlias.destroy()
    res.send()
})
