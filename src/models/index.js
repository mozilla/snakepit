const glob = require('glob')
const path = require('path')

var exports = module.exports = { all: [] }

glob.sync(__dirname + '/*-model.js').forEach(moduleName => {
    let modelName = path.basename(moduleName)
    modelName = modelName.substr(0, modelName.lastIndexOf('-'))
    let model = require(path.resolve(moduleName))
    exports[modelName] = model
    exports.all.push(model)
})
exports.sequelize = require('./db.js')