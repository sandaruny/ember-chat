import DS from 'ember-data';

export default DS.Model.extend({
  host: DS.attr('string'),
  pw: DS.attr('string'),
  jid : DS.attr('string')
});
