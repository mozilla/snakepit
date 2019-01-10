const glob = require('glob')
const path = require('path')

var exports = module.exports = { all: [] }

glob.sync('./*-model.js').forEach(moduleName => {
    let modelName = moduleName.substr(0, moduleName.indexOf('-'))
    let model = require(path.resolve(moduleName))
    exports[modelName] = model
    exports.all.push(model)
})
exports.sequelize = require('./db.js')