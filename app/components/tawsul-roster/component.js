import Ember from 'ember';

export default Ember.Component.extend({


  model(){
    return {
      data: this.store.findAll('message'),
      message: {}
    }
  }
});
