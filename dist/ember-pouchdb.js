(function(globals) {
var define, requireModule;

(function() {
  var registry = {}, seen = {};

  define = function(name, deps, callback) {
    registry[name] = { deps: deps, callback: callback };
  };

  requireModule = function(name) {
    if (seen[name]) { return seen[name]; }
    seen[name] = {};

    var mod = registry[name];
    if (!mod) {
      throw new Error("Module '" + name + "' not found.");
    }

    var deps = mod.deps,
        callback = mod.callback,
        reified = [],
        exports;

    for (var i=0, l=deps.length; i<l; i++) {
      if (deps[i] === 'exports') {
        reified.push(exports = {});
      } else {
        reified.push(requireModule(deps[i]));
      }
    }

    var value = callback.apply(this, reified);
    return seen[name] = exports || value;
  };
})();

define("ember-pouchdb/get_initializer",
  ["ember-pouchdb/storage","ember-pouchdb/promise_tracker","exports"],
  function(__dependency1__, __dependency2__, __exports__) {
    "use strict";
    var Storage = __dependency1__.Storage;
    var PromiseTracker = __dependency2__.PromiseTracker;

    var get_initializer = function(options, initialize) {

      options = Ember.merge({
        /**
         * Name of the initializer
         * @type {String}
         */
        name: "PouchDB",
        /**
         * Property that the instance will be injected onto
         * @type {String}
         */
        propName: "pouch",
        /**
         * Name of the database
         * @type {String}
         */
        dbName: "PouchDB",
        /**
         * fullName of the type to register
         * @link https://github.com/emberjs/ember.js/blob/master/packages/container/lib/main.js#L258
         * @type {String}
         */
        fullName: 'pouch:main',
        /**
         * Types to inject property into
         * @type {Array}
         */
        types: [ 'controller', 'route' ],
        /**
         * Object with docType as key and model class as value
         * Example:
         *   {
         *     'photo': App.PhotoModel,
         *     'product': App.ProductModel
         *   }
         * @type {Object}
         */
        docTypes: {}
      }, options);

      /**
       * Callback function to initilizer
       * @param  {Application}  application Application instance thats being initalized
       * @param  {Container}    container   Application's container
       * @return {object}             
       */
      if ( typeof initialize === 'undefined' ) {
        initialize = function(container, application) {
          application.register(options.fullName, Storage.extend({
            dbName: application.get('pouch.dbName') || options.dbName,
            docTypes: application.get('pouch.docTypes') || options.docTypes
          }));
          options.types.forEach(function(type){
            application.inject(type, options.propName, options.fullName);
          });
      
          if ( Ember.testing ) {
            // Inject Promise Tracker into the storage instance
            application.register("promiseTracker:pouch", PromiseTracker);
            application.inject(options.fullName, "tracker", "promiseTracker:pouch");
          }
      
        };
      }

      options['initialize'] = initialize;

      return options;
    };

    __exports__.get_initializer = get_initializer;
  });
define("ember-pouchdb/model",
  ["exports"],
  function(__exports__) {
    "use strict";
    var Model = Ember.Object.extend( Ember.Copyable, {
      copy: function() {
        var serialized  = this.serialize();
        serialized.id   = this.get('id');
        serialized.rev  = this.get('rev');
        return this.constructor.create(serialized);
      },
      serialize: function() {
        throw new Error(Ember.String.fmt("%@ must implement serialize() method which returns JSON of this model.", [this]));
      }
    });

    __exports__.Model = Model;
  });
define("ember-pouchdb/promise_tracker",
  ["exports"],
  function(__exports__) {
    "use strict";
    var PromiseTracker = Ember.ArrayProxy.extend({
      init: function(){
        var that = this;
        // register a Waiter function if wait-hooks feature is available
        if ( Ember.FEATURES.isEnabled('ember-testing-wait-hooks') ) {
          Ember.Test.registerWaiter(function() {
             return that.areFulfilled() === true;
          });      
        }
        this.set('content', []);
      },
      newPromise: function(callback) {
        // save a reference to it in the tracker and return a new promise
        var promise = new Ember.RSVP.Promise(callback);
        this.pushObject(promise);
        return promise;
      },
      areFulfilled: function(){
        // return true if all promises are fulfilled
        return this.everyBy('isFulfilled');
      }
    });

    __exports__.PromiseTracker = PromiseTracker;
  });
define("ember-pouchdb/storage",
  ["ember-pouchdb/model","exports"],
  function(__dependency1__, __exports__) {
    "use strict";
    var Model = __dependency1__.Model;

    var Storage = Ember.Object.extend({
      /**
       * Name of this database
       * @type {string}
       */
      dbName: null,
      /**
       * Object with docType as key and model class as value.
       * TODO: remove this after https://github.com/stefanpenner/ember-app-kit/issues/124 is fixed
       * Example:
       *   {
       *     'photo': App.PhotoModel,
       *     'product': App.ProductModel
       *   }
       * @type {Object}
       */
      docTypes: {},
      /**
       * Defines a remote couch, if set a bidirectional replication (sync) is initialised.
       * Either a PouchDB instance or a string representing a CouchDB database URL or the name of a local PouchDB database
       *
       * @see http://pouchdb.com/api.html#replication
       */
      remoteCouch: null,
      init: function() {
        var that = this;
        this.getDB();
        this.setupReplication();

        // Add basic "by_doctype" view
        this.getDB().then(function(db) {
          db.put(that.createDesignDoc('by_doctype', function (doc) {
            emit(doc.docType);
          }));
        });
      },
      getDB: function(dbName, options) {
        var that = this, promise = this.get('_dbPromise');

        if ( Em.isEmpty(promise) ) {
          promise = this.create(dbName, options);
          promise.then(function(db){
            that.set('_db', db);
            return db;
          });
          this.set('_dbPromise', promise);
        }
        return promise;
      },
      /**
       * Create new design doc (http://pouchdb.com/2014/05/01/secondary-indexes-have-landed-in-pouchdb.html)
       * @param name Name of the view
       * @param mapFunction Map Function
       * @returns {{_id: string, views: {}}}
       */
      createDesignDoc: function (name, mapFunction) {
        var ddoc = {
          _id: '_design/' + name,
          views: {
          }
        };
        ddoc.views[name] = { map: mapFunction.toString() };
        return ddoc;
      },
      /**
       * Initializes replication with a remoteCouch
       */
      setupReplication: function() {
        if ( !Em.isEmpty(this.get('remoteCouch')) ) {
          this.set('_replication', PouchDB.sync(this.get('dbName'), this.get('remoteCouch'), {live: true}));
        }
      },
      /**
       * Cancel replication with the remoteCouch
       */
      cancelReplication: function() {
        if(!Em.isEmpty(this.get('_replication'))) {
          this.get('_replication').cancel();
          this.set('_replication', null);
        }
      },
      /**
       * Create database by name
       * 
       * @param  {string} name    of the database to create
       * @param  {object} options 
       * @return {promise}        that will resolve to instance of Pouch
       */
      create: function( name, options ) {

        if (typeof name === 'undefined') {
          name = this.get('dbName');
        }

        if (typeof options === 'undefined') {
          options = {};
        }

        var createDB = function(resolve, reject){
          var _createDB = function(error, db){
            Ember.run(function(){
              if ( error ) {
                reject(error);
              } else {
                resolve(db);
              }
            });
          };
          new PouchDB(name, options, _createDB);
        };

        return this._newPromise(createDB);
      },
      /**
       * Get all docs of specific docType. The docs will be converted into models before being returned.
       * 
       * @param  {string} docType 
       * @param  {object} options
       * @return {promise}        
       */
      findAll: function(docType, options) {
        var modelClass = this.get('docTypes.'+docType);
        Ember.assert("You have to register %@ docType before you can query by it. Look at docTypes property in PouchStorage class.".fmt(docType), modelClass);

        if ( typeof options === 'undefined' ) {
          options = {
            reduce:false
          };
        }

        options.include_docs = true;
        options.key = docType;

        var that = this;
        var queryByDocType = function(db){
          var promise = that._newPromise(function(resolve, reject){
            var _queryByDocType = function(error, response){
              Ember.run(function(){
                if ( error ) {
                  reject(error);
                } else {
                  resolve(response);
                }
              });
            };
            db.query("by_doctype", options, _queryByDocType);
          });
          return promise;
        };

        var createModels = function(docs) {
          return Em.A(docs.rows).map(function(doc){
            var model = modelClass.create(doc.doc);
            model.setProperties({id:doc.doc._id, rev:doc.doc._rev});
            return model;
          });
        };

        return this.getDB().then(queryByDocType).then(createModels);
      },
      /**
       * Executes a query.
       *
       * @param {function} fun
       * @param {object} options
       * @return {promise}
       */
      query: function(fun, options) {
        var that = this;

        if ( typeof options === 'undefined' ) {
          options = {
          };
        }
        options.reduce = false;
        options.include_docs = true;

        var query = function(db){
          return that._newPromise(function (resolve, reject) {
            var _query = function (error, response) {
              Ember.run(function () {
                if (error) {
                  reject(error);
                } else {
                  resolve(response);
                }
              });
            };
            db.query(fun, options, _query);
          });
        };

        var createModels = function(docs) {
          return Em.A(docs.rows).map(function(row){
            var
              doc = row.doc,
              modelClass = that.get('docTypes.'+doc.docType);
            Ember.assert("You have to register %@ docType before you can query by it. Look at docTypes property in PouchStorage class.".fmt(doc.docType), modelClass);
            var model = modelClass.create(doc);
            model.setProperties({id:doc._id, rev:doc._rev});
            return model;
          });
        };

        return this.getDB().then(query).then(createModels);
      },
      /**
       * Get a document by id, return a promise that will resolve to an instance of PouchModel
       *
       * options and default values
       * {
       *  rev: undefined     // Fetch specific revision of a document.
       *  revs: []           // Include revision history of the document
       *  revs_info: false   // Include a list of revisions of the document, and their availability.
       *  open_revs: false   // Fetch all leaf revisions if openrevs="all" or fetch all leaf revisions specified in openrevs array. Leaves will be returned in the same order as specified in input array
       *  conflicts: false   // If specified conflicting leaf revisions will be attached in _conflicts array
       *  attachments: false // Include attachment data
       *  local_seq: false   // Include sequence number of the revision in the database
       * }
       * 
       * @param {string} id      of the document to get a model for
       * @param {object} options hash of options
       * @return {promise}       that will resolve to a model
       */
      GET: function(id, options) {

        if ( typeof options === 'undefined' ) {
          options = {};
        }

        var that = this;

        var getDoc = function(db){
          var promise = that._newPromise(function(resolve, reject){
            var _getDoc = function(error, response){
              Ember.run(function(){
                if (error) {
                  reject(error);
                } else {
                  resolve(response);
                }
              });
            };
            db.get(id, options, _getDoc);
          });
          return promise;
        }

        var createModel = function(doc) {
          var model;
          if ( doc.hasOwnProperty('docType') && that.get('docTypes.'+doc.docType)) {
            var modelClass = that.get('docTypes.'+doc.docType);
            model = modelClass.create(doc);
          } else {
            model = Model.create(doc);
          }

          model.setProperties({id:doc._id, rev:doc._rev});
          delete model._id;
          delete model._rev;
      
          return model;
        };

        return this.getDB().then(getDoc).then(createModel);
      },
      /**
       * Create a new document and let PouchDB generate an _id for it.
       * If model is an array, all documents will inserted and the completed array (with _id) will be returned
       *
       * @param {PunchModel} model    Either an instance or an array of instances of descendant of PunchModel
       * @param {object} options      object with options
       * @return {promise}            which will resolve to updated model
       */
      POST: function(model, options) {
        var
          that          = this;

        // Bulk insert
        if(Em.isArray(model)) {
          var docs = [];
          model.forEach(function (item) {
            var doc           = item.serialize(),
              docType       = that.getDocType(item.constructor);

            Em.assert("Model doesn't have a corresponding doc type.", docType);
            doc['docType'] = docType;
            item.set('docType', docType);

            docs.push(doc);
          });

          var bulkDocs = function(db){
            var promise = that._newPromise(function(resolve, reject){
              var _bulkDocs = function(error, response){
                Ember.run(function(){
                  if ( error ) {
                    reject(error);
                  } else {
                    resolve(response);
                  }
                });
              };
              db.bulkDocs(docs, options, _bulkDocs);
            });
            return promise;
          };

          var addAllDocInfo = function(info) {
            info.forEach(function (item, index) {
              model[index].set('id', item.id);
              model[index].set('rev', item.rev);
            });
            return model;
          };

          return this.getDB().then(bulkDocs).then(addAllDocInfo);
        } else {
          var doc           = model.serialize(),
            docType       = this.getDocType(model.constructor);

          Em.assert("Model doesn't have a corresponding doc type.", docType);

          doc['docType'] = docType;

          var postDoc = function(db){
            var promise = that._newPromise(function(resolve, reject){
              var _postDoc = function(error, response){
                Ember.run(function(){
                  if ( error ) {
                    reject(error);
                  } else {
                    resolve(response);
                  }
                });
              };
              db.post(doc, options, _postDoc);
            });
            return promise;
          };

          var addDocInfo = function(info) {
            model.set('id', info.id);
            model.set('rev', info.rev);
            model.set('docType', docType);
            return model;
          };

          return this.getDB().then(postDoc).then(addDocInfo);
        }
      },
      /** 
       * Update an existing document.
       * 
       * @param {model} model   to update
       * @param {object} options 
       * @return {model} [description]
       */
      PUT: function(model, options) {
        var
          that          = this, 
          doc           = model.serialize(),
          docType       = null;

        if ( typeof options === 'undefined' ) {
          options = {};
        }

        if ( !model.get('docType') ) {
          model.set('docType', this.getDocType(model.constructor));
        }

        doc["docType"] = model.get('docType') || this.getDocType(model.constructor);
        doc["_id"] = model.get("id");
        doc["_rev"] = model.get("rev");

        var putDoc = function(db){
          var promise = that._newPromise(function(resolve, reject){
            var _putDoc = function(error, response) {
              Ember.run(function(){
                if ( error ) {
                  reject(error);
                } else {
                  resolve(response);
                }
              });
            };
            db.put(doc, options, _putDoc);
          });
          return promise;
        }

        var updateModel = function(doc) {
          model.setProperties({id: doc.id, rev: doc.rev});
          return model;
        };

        return this.getDB().then(putDoc).then(updateModel);
      },
      /** 
       * Delete document(s) for a model or an array of models
       * 
       * @param {model} model   must have id & rev properties
       * @param {object} options 
       * @return
       */
      DELETE: function(model, options) {

        var doc;

        if ( typeof options === 'undefined' ) {
          options = {};
        }

        // Bulk delete
        if(Em.isArray(model)) {
          doc = [];
          model.forEach(function(item) {
            doc.push({
              _id: item.get('id'),
              _rev: item.get('rev'),
              _deleted: true
            })
          });
        } else {
          doc = {
            _id: model.get('id'),
            _rev: model.get('rev')
          };
        }

        var that = this;

        var removeDoc = function(db){
          var promise = that._newPromise(function(resolve, reject){
            var _removeDoc = function(error, response) {
              Ember.run(function(){
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            };
            if(Em.isArray(doc)) {
              db.bulkDocs(doc, options, _removeDoc);
            } else {
              db.remove(doc, options, _removeDoc);
            }
          });
          return promise;
        };

        return this.getDB().then(removeDoc);
      },
      /**
       * Remove the database
       * @return {promise}
       */
      remove: function(options) {

        var that = this, dbName = that.get('dbName');

        if ( typeof options === 'undefined' ) {
          options = {};
        }

        var removeDB = function(resolve, reject){
          var _removeDB = function(error, info){
            Ember.run(function(){
              if (error) {
                reject(error);
              } else {
                resolve(info);
              }
            });
          };
          PouchDB.destroy(dbName, _removeDB);
        };

        return this._newPromise(removeDB);
      },
      getDocType: function(modelClass) {
        var 
          found     = false,
          docTypes  = this.get('docTypes');
        Object.keys(docTypes).find(function(type){
          if ( Em.isEqual(docTypes[type], modelClass) ) {
            found = type;
          }
          return found;
        });
        return found;
      },
      /**
       * Return a new promise, create a tracked promise if promise tracker is available
       * @param {function} callback
       * @return {promise}
       */
      _newPromise: function(callback) {
        var promise;
        if ( this.tracker != null ) {
          promise = this.tracker.newPromise(callback);
          promise.stack = new Error().stack;      
        } else {
          promise = new Ember.RSVP.Promise(callback);
        }
        return promise;
      }
    });

    __exports__.Storage = Storage;
  });
define("ember-pouchdb",
  ["ember-pouchdb/get_initializer","ember-pouchdb/model","ember-pouchdb/storage","exports"],
  function(__dependency1__, __dependency2__, __dependency3__, __exports__) {
    "use strict";
    var get_initializer = __dependency1__.get_initializer;
    var Model = __dependency2__.Model;
    var Storage = __dependency3__.Storage;

    __exports__.get_initializer = get_initializer;
    __exports__.Model = Model;
    __exports__.Storage = Storage;
  });
window.EPDB = requireModule("ember-pouchdb");
})(window);