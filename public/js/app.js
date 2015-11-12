

App = Ember.Application.create();
var Router = Ember.Router.extend({

});

App.Store = DS.Store.extend({
  revision: 12,
  url: 'http://localhost/converse-api/store'
});

App.Pull = DS.Model.extend({
  title: DS.attr(),
  url: DS.attr(),
});

Router.map(function(){

});

var store = this.store;


App.PullRoute = Ember.Route.extend({
  model: function () {
    return this.store.createRecord('pull', {
      title: 'Rails is Omakase',
      url: 'Lorem ipsum'
    });
  }
});
