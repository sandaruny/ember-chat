import DS from 'ember-data';

export default DS.Model.extend({
  host: DS.attr('string'),
  resource: DS.attr('string')
});
