

class BagException {}

class Bag {
    constructor(...dims) {
        this.dims = dims
        this.data = {}
    }

    set(...dimValues) {
        if (dimValues.length != this.dims.length) {
            throw new BagException()
        }
        let value = dimValues.pop()
        let key = dimValues.pop()
        var current = this.data
        for(let dimValue in dimValues) {
            current = current[dimValue] = current[dimValue] || {}
        }
        current[key] = value
    }

    _get(...dimValues) {
        var current = this.data
        for(let dimValue in this.dimValues) {
            current = current[dimValue]
            if (!current) {
                return undefined
            }
        }
        return current
    }

    get(...dimValues) {
        if (dimValues.length != this.dims.length - 1) {
            throw new BagException()
        }
        return this._get(...dimValues)
    }

    _getItems(callback, ...dimValues) {
        if (dimValues.length == this.dims.length) {
            callback(...dimValues)
        } else {
            let hash = this._get(...dimValues)
            for(let key of Object.keys(hash)) {
                this._getItems(callback, ...dimValues, key)
            }
        }
    }

    forEach(callback) {
        this._getItems(callback)
    }

    get items() {
        let collected = []
        this._getItems((...dimValues) => {
            let obj = {}
            for(let i=0; i<this.dims.length; i++) {
                obj[this.dims[i]] = dimValues[i]
            }
            collected.push(obj)
        })
        return collected
    }


}