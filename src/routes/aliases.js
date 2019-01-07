const Router = require('express-promise-router')
const Alias = require('../models/Alias-model.js')

const { ensureSignedIn, ensureAdmin } = require('./users.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Alias.findAll()).map(alias => alias.id))
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

router.delete('/:id', async (req, res) => {
    await Alias.destroy({ where: { id: req.params.id } })
    res.send()
})
