//! Opérations sur le document et historique annuler / rétablir.
//!
//! Chaque opération sait s'appliquer et produire son inverse : annuler
//! revient à appliquer l'inverse. Pour l'instant les opérations travaillent
//! au niveau des blocs de premier niveau ; des opérations plus fines
//! (insertion de texte, mise en forme d'une plage) viendront ensuite.

use tm_model::{Block, Document};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OpError {
    #[error("position {index} hors du document (longueur {len})")]
    OutOfBounds { index: usize, len: usize },
}

/// Une modification élémentaire du document.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Insère `block` à la position `index`.
    InsertBlock { index: usize, block: Block },
    /// Supprime le bloc à la position `index`.
    RemoveBlock { index: usize },
    /// Remplace le bloc à la position `index` par `block`.
    ReplaceBlock { index: usize, block: Block },
}

impl Op {
    /// Applique l'opération et renvoie l'opération inverse.
    pub fn apply(self, doc: &mut Document) -> Result<Op, OpError> {
        let len = doc.content.len();
        match self {
            Op::InsertBlock { index, block } => {
                if index > len {
                    return Err(OpError::OutOfBounds { index, len });
                }
                doc.content.insert(index, block);
                Ok(Op::RemoveBlock { index })
            }
            Op::RemoveBlock { index } => {
                if index >= len {
                    return Err(OpError::OutOfBounds { index, len });
                }
                let block = doc.content.remove(index);
                Ok(Op::InsertBlock { index, block })
            }
            Op::ReplaceBlock { index, block } => {
                let slot = doc
                    .content
                    .get_mut(index)
                    .ok_or(OpError::OutOfBounds { index, len })?;
                let old = std::mem::replace(slot, block);
                Ok(Op::ReplaceBlock { index, block: old })
            }
        }
    }
}

/// Un document accompagné de son historique.
#[derive(Debug, Default)]
pub struct Editor {
    doc: Document,
    undo: Vec<Op>,
    redo: Vec<Op>,
}

impl Editor {
    pub fn new(doc: Document) -> Self {
        Self {
            doc,
            ..Self::default()
        }
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// Applique une opération. Elle pourra être annulée ; ce qui avait été
    /// annulé ne peut plus être rétabli.
    pub fn apply(&mut self, op: Op) -> Result<(), OpError> {
        let inverse = op.apply(&mut self.doc)?;
        self.undo.push(inverse);
        self.redo.clear();
        Ok(())
    }

    /// Annule la dernière opération. Renvoie `false` s'il n'y a rien à annuler.
    pub fn undo(&mut self) -> bool {
        Self::step(&mut self.doc, &mut self.undo, &mut self.redo)
    }

    /// Rétablit la dernière opération annulée. Renvoie `false` s'il n'y a rien à rétablir.
    pub fn redo(&mut self) -> bool {
        Self::step(&mut self.doc, &mut self.redo, &mut self.undo)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    fn step(doc: &mut Document, from: &mut Vec<Op>, to: &mut Vec<Op>) -> bool {
        let Some(op) = from.pop() else {
            return false;
        };
        let inverse = op
            .apply(doc)
            .expect("l'inverse d'une opération appliquée s'applique toujours");
        to.push(inverse);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(editor: &Editor) -> String {
        editor.document().plain_text()
    }

    #[test]
    fn inserer_annuler_retablir() {
        let mut ed = Editor::new(Document::new(vec![Block::paragraph("a")]));
        ed.apply(Op::InsertBlock { index: 1, block: Block::paragraph("b") })
            .unwrap();
        ed.apply(Op::ReplaceBlock { index: 0, block: Block::heading(1, "A") })
            .unwrap();
        assert_eq!(texts(&ed), "A\nb\n");

        assert!(ed.undo());
        assert_eq!(texts(&ed), "a\nb\n");
        assert!(ed.undo());
        assert_eq!(texts(&ed), "a\n");
        assert!(!ed.undo());

        assert!(ed.redo());
        assert!(ed.redo());
        assert_eq!(texts(&ed), "A\nb\n");
        assert!(!ed.redo());
    }

    #[test]
    fn une_nouvelle_operation_vide_le_retablir() {
        let mut ed = Editor::new(Document::new(vec![Block::paragraph("a")]));
        ed.apply(Op::RemoveBlock { index: 0 }).unwrap();
        ed.undo();
        assert!(ed.can_redo());
        ed.apply(Op::InsertBlock { index: 0, block: Block::paragraph("z") })
            .unwrap();
        assert!(!ed.can_redo());
        assert_eq!(texts(&ed), "z\na\n");
    }

    #[test]
    fn hors_limites() {
        let mut ed = Editor::default();
        assert_eq!(
            ed.apply(Op::RemoveBlock { index: 0 }),
            Err(OpError::OutOfBounds { index: 0, len: 0 })
        );
        assert!(!ed.can_undo());
    }
}
