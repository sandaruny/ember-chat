import { moduleForComponent, test } from 'ember-qunit';
import hbs from 'htmlbars-inline-precompile';

moduleForComponent('tawsul-roster-contact', 'Integration | Component | tawsul roster contact', {
  integration: true
});

test('it renders', function(assert) {
  assert.expect(2);

  // Set any properties with this.set('myProperty', 'value');
  // Handle any actions with this.on('myAction', function(val) { ... });

  this.render(hbs`{{tawsul-roster-contact}}`);

  assert.equal(this.$().text().trim(), '');

  // Template block usage:
  this.render(hbs`
    {{#tawsul-roster-contact}}
      template block text
    {{/tawsul-roster-contact}}
  `);

  assert.equal(this.$().text().trim(), 'template block text');
});
