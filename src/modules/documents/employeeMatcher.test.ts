import { matchEmployeeByFilename, MatchableEmployee } from './employeeMatcher';

let nextId = 1;
const emp = (name: string, surname: string, companyId = 1, uniqueId: string | null = null): MatchableEmployee =>
  ({ id: nextId++, name, surname, company_id: companyId, unique_id: uniqueId });

describe('matchEmployeeByFilename', () => {
  describe('the five payslips the client reported as mis-assigned', () => {
    // In the client's system the real holders were absent from the roster, so
    // the old matcher handed each document to the one employee sharing a single
    // field. Every one of these must now stay unassigned.

    it('does not assign to "Anna Conti" because "anna" sits inside "Giovanna"', () => {
      const result = matchEmployeeByFilename('MULLONI_GIOVANNA_13.pdf', [emp('Anna', 'Conti')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.employee).toBeNull();
    });

    it('does not assign on first name alone (Veronica)', () => {
      const result = matchEmployeeByFilename('DE FALCO_VERONICA_40.pdf', [emp('Veronica', 'Baldesi')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.reason).toBe('first_name_only');
    });

    it('does not assign on surname alone (Piscopo)', () => {
      const result = matchEmployeeByFilename('PISCOPO_ROSA_18.pdf', [emp('Francesco', 'Piscopo')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.reason).toBe('surname_only');
    });

    it('does not assign Percope\'s payslip to the only other Francesco', () => {
      const result = matchEmployeeByFilename('PERCOPE_FRANCESCO_15.pdf', [emp('Francesco', 'Piscopo')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });

    it('does not assign on first name alone (Francesca)', () => {
      const result = matchEmployeeByFilename('BAIANO_FRANCESCA_33.pdf', [emp('Francesca', 'Murè')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });
  });

  describe('the Perrotta prefix collision', () => {
    // "perrotta" + "pasqua" is a prefix of "perrottapasqualina", so the old
    // substring rule scored Pasqua Perrotta in a "full name" tier.
    it('never lets a shorter name match a longer name it prefixes', () => {
      const result = matchEmployeeByFilename('PERROTTA_PASQUALINA_32.pdf', [emp('Pasqua', 'Perrotta')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });

    it('still assigns correctly when both Perrotta employees exist', () => {
      const pasqualina = emp('Pasqualina', 'Perrotta');
      const result = matchEmployeeByFilename('PERROTTA_PASQUALINA_32.pdf', [pasqualina, emp('Pasqua', 'Perrotta')], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(pasqualina.id);
    });

    it('assigns the shorter name to its own document', () => {
      const pasqua = emp('Pasqua', 'Perrotta');
      const result = matchEmployeeByFilename('PERROTTA_PASQUA_31.pdf', [emp('Pasqualina', 'Perrotta'), pasqua], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(pasqua.id);
    });
  });

  describe('correct assignments still happen', () => {
    it('SURNAME_NAME order', () => {
      const target = emp('Giovanna', 'Mulloni');
      const result = matchEmployeeByFilename('MULLONI_GIOVANNA_13.pdf', [target, emp('Anna', 'Conti')], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(target.id);
    });

    it('NAME_SURNAME order', () => {
      const target = emp('Giovanna', 'Mulloni');
      const result = matchEmployeeByFilename('GIOVANNA_MULLONI.pdf', [target], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
    });

    it('multi-word surname split across tokens', () => {
      const target = emp('Veronica', 'De Falco');
      const result = matchEmployeeByFilename('DE FALCO_VERONICA_40.pdf', [target, emp('Veronica', 'Baldesi')], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(target.id);
    });

    it('accented surname matched from an unaccented filename', () => {
      const target = emp('Francesco', 'Percopé');
      const result = matchEmployeeByFilename('PERCOPE_FRANCESCO_15.pdf', [target, emp('Francesco', 'Piscopo')], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(target.id);
    });

    it('apostrophe surname, written with and without a separator', () => {
      const target = emp('Carmela', "Dell'Aversano");
      expect(matchEmployeeByFilename("DELL'AVERSANO_CARMELA.pdf", [target], { companyId: 1 }).outcome).toBe('assigned');
      expect(matchEmployeeByFilename('DELL AVERSANO_CARMELA.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
      expect(matchEmployeeByFilename('DELLAVERSANO_CARMELA.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('tolerates extra descriptive words in the filename', () => {
      const target = emp('Mario', 'Rossi');
      const result = matchEmployeeByFilename('ROSSI_MARIO_CEDOLINO_GENNAIO_2026.pdf', [target], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
    });

    it('no separators at all', () => {
      const target = emp('Mario', 'Rossi');
      expect(matchEmployeeByFilename('rossimario.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });
  });

  describe('ambiguity is never resolved silently', () => {
    it('two employees with the same full name stay unassigned', () => {
      const result = matchEmployeeByFilename('BIANCO_MARCO.pdf', [emp('Marco', 'Bianco'), emp('Marco', 'Bianco')], { companyId: 1 });
      expect(result.outcome).toBe('ambiguous');
      expect(result.employee).toBeNull();
      expect(result.candidates).toHaveLength(2);
    });

    it('reports several same-first-name employees as suggestions, not a match', () => {
      const result = matchEmployeeByFilename('BAIANO_FRANCESCA_33.pdf',
        [emp('Francesca', 'Murè'), emp('Francesca', 'Costa')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.every(c => !c.strong)).toBe(true);
    });
  });

  describe('company scoping is a hard gate', () => {
    it('does not assign an exact match belonging to another company', () => {
      const result = matchEmployeeByFilename('PISCOPO_ROSA_18.pdf', [emp('Rosa', 'Piscopo', 4)], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.reason).toBe('other_company');
    });

    it('still offers the other-company employee as a suggestion', () => {
      const result = matchEmployeeByFilename('PISCOPO_ROSA_18.pdf', [emp('Rosa', 'Piscopo', 4)], { companyId: 1 });
      expect(result.candidates[0].reason).toBe('other_company');
      expect(result.candidates[0].strong).toBe(false);
    });

    it('picks the in-company employee when the same name exists in two companies', () => {
      const mine = emp('Rosa', 'Piscopo', 1);
      const result = matchEmployeeByFilename('PISCOPO_ROSA_18.pdf', [emp('Rosa', 'Piscopo', 4), mine], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.employee?.id).toBe(mine.id);
    });

    it('without a company scope, a cross-company duplicate is ambiguous', () => {
      const result = matchEmployeeByFilename('PISCOPO_ROSA_18.pdf', [emp('Rosa', 'Piscopo', 1), emp('Rosa', 'Piscopo', 4)], {});
      expect(result.outcome).toBe('ambiguous');
    });
  });

  describe('unique_id can no longer be hijacked by a sequence number', () => {
    it('ignores a short numeric id appearing as a payslip sequence number', () => {
      const result = matchEmployeeByFilename('MULLONI_GIOVANNA_13.pdf', [emp('Anna', 'Conti', 1, '13')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });

    it('does not match a unique_id found only as a substring', () => {
      const result = matchEmployeeByFilename('CEDOLINO_FU12345.pdf', [emp('Anna', 'Conti', 1, 'FU123')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });

    it('matches a full-length unique_id present as a whole token', () => {
      const target = emp('Anna', 'Conti', 1, 'FU-EMP-001');
      const result = matchEmployeeByFilename('FUEMP001_cedolino.pdf', [target], { companyId: 1 });
      expect(result.outcome).toBe('assigned');
      expect(result.reason).toBe('unique_id');
    });
  });

  describe('real-world filename shapes from payroll exports', () => {
    it('digits glued onto the first name still match ("COSTA_Stefano34")', () => {
      const target = emp('Stefano', 'Costa');
      expect(matchEmployeeByFilename('COSTA_Stefano34.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('a surname stored joined matches a filename that splits it ("De Luca" -> "DeLuca")', () => {
      const target = emp('Giulia', 'DeLuca');
      expect(matchEmployeeByFilename('Giulia De Luca.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('a surname stored split matches a filename that joins it', () => {
      const target = emp('Giulia', 'De Luca');
      expect(matchEmployeeByFilename('Giulia_DeLuca.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('camelCase with no separator', () => {
      const target = emp('Mattia', 'Lombardi');
      expect(matchEmployeeByFilename('mattiaLombardi.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('leading date prefix is ignored', () => {
      const target = emp('Francesco', 'Bruno');
      expect(matchEmployeeByFilename('29-07-2026_Francesco_Bruno.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('ampersand and dots behave like separators', () => {
      const target = emp('Lorenzo', 'Rossi');
      expect(matchEmployeeByFilename('Lorenzo&Rossi.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
      expect(matchEmployeeByFilename('Lorenzo.Rossi.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('leading underscore and trailing words are ignored', () => {
      const target = emp('Matteo', 'Barbieri');
      expect(matchEmployeeByFilename('_Barbieri_Matteo_09.pdf', [target], { companyId: 1 }).outcome).toBe('assigned');
      expect(matchEmployeeByFilename('Antonio_Marino_Invoice_July2026.pdf', [emp('Antonio', 'Marino')], { companyId: 1 }).outcome).toBe('assigned');
    });

    it('token joining still cannot make a shorter name match a longer one', () => {
      // The Perrotta guarantee must survive the new joined-window tokens.
      expect(matchEmployeeByFilename('PERROTTA_PASQUALINA_32.pdf', [emp('Pasqua', 'Perrotta')], { companyId: 1 }).outcome).toBe('unmatched');
      // ...and joining must not fabricate a person out of two unrelated names.
      expect(matchEmployeeByFilename('MARIO_ROSSI_LUCA_BIANCHI.pdf', [emp('Rossiluca', 'Mario')], { companyId: 1 }).outcome).toBe('unmatched');
    });

    it('stripping trailing digits cannot turn one name into another', () => {
      // "pasqualina34" -> "pasqualina", never "pasqua".
      expect(matchEmployeeByFilename('PERROTTA_Pasqualina34.pdf', [emp('Pasqua', 'Perrotta')], { companyId: 1 }).outcome).toBe('unmatched');
    });
  });

  describe('non-name files', () => {
    it('a purely numeric filename matches nobody', () => {
      const result = matchEmployeeByFilename('2643_CEDOLINO.xml', [emp('Anna', 'Conti')], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });

    it('an empty roster yields no candidates', () => {
      const result = matchEmployeeByFilename('ROSSI_MARIO.pdf', [], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
      expect(result.reason).toBe('no_candidate');
    });

    it('employees with a missing surname are never matched', () => {
      const result = matchEmployeeByFilename('MARIO.pdf', [{ id: 99, name: 'Mario', surname: null, company_id: 1 }], { companyId: 1 });
      expect(result.outcome).toBe('unmatched');
    });
  });
});
