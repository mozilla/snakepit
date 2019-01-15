const path = require('path')
const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const config = require('../config.js')

const fs = require('fs-extra')

var Pit = sequelize.define('pit', {
    id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true }
})

const pitPrefix = '/data/pits/'

Pit.afterCreate(async pit => {
    let pitDir = pitPrefix + pit.id
    if (!(await fs.pathExists(pitDir))) {
        await fs.mkdirp(pitDir)
    }
})

Pit.afterDestroy(async pit => {
    let pitDir = pitPrefix + pit.id
    if (await fs.pathExists(pitDir)) {
        await fs.remove(pitDir)
    }
})

Pit.getDir = (pitId) => pitPrefix + pitId
Pit.prototype.getDir = function () {
    return Pit.getDir(this.id)
}

Pit.getDirExternal = (pitId) => path.join(config.mountRoot, 'pits', pitId + '')
Pit.prototype.getDirExternal = function () {
    return Pit.getDirExternal(this.id)
}

module.exports = Pit
