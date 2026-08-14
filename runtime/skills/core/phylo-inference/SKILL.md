---
name: phylo-inference
description: Use when the user wants to build, interpret, or visualize a phylogenetic tree from sequence data — sequence retrieval, alignment (MAFFT), model selection, tree inference (IQ-TREE/RAxML), branch support, rooting, and publication-grade figures. Runs the domain-check gate on any tree/distance code, keeps every branch length, support value, and label traceable to the code and input sequences.
---

# Phylogenetic inference

End-to-end tree building from sequences, with every number on the tree traced to
the code and input files.

## Workflow

1. **Get the sequences.** The user names a sequence file (FASTA) in the workspace
   — there are no bundled example sequences. Confirm the file before starting.
   Optional: fetch GenBank/NCBI sequences with `Entrez` only if the user asks.
   Record the source of every sequence (accession / file + header).

2. **Align with MAFFT.**
   ```
   mafft --auto in.fasta > aln.fasta
   ```
   For protein-coding DNA, align the translated amino acids (or use codon-aware
   alignment, e.g. MACSE) and translate the tree back to the coding frame.
   Inspect the alignment (length, gaps); do not silently keep a broken one.

3. **Model selection + tree inference (IQ-TREE).** Maximum likelihood, with
   ultrafast bootstrap support from the start:
   ```
   iqtree2 -s aln.fasta -m MFP -B 1000 --nni --alrt 1000 -redo -T AUTO
   ```
   `-m MFP` selects the best model by BIC; `-B 1000` gives UFBoot support values;
   `-alrt 1000` adds SH-aLRT. Never present an ML tree without both — a bare
   topology is a parsimony tree, not a supported ML tree. Report the selected
   model and its BIC in the report.

4. **Rooting.** Root on an explicit outgroup when one is in the sample (preferred
   and reproducible). If you must root by midpoint, say so and why. Never present
   an arbitrary/undocumented root.

5. **Publication-grade figure (toytree).** Draw the tree with support values on
   branches (UFBoot ≥ 95 highlighted, or SH-aLRT ≥ 80), scale bar in
   substitutions per site, and a legend for the support labels:
   ```
   import toytree, toyplot
   tree = toytree.tree("aln.fasta.treefile", feature="ufboot")  # or alrt
   canvas, axes, mark = tree.draw(tip_labels_style={"font-size": "9px"}, ...)
   ```
   Save a static PNG/PDF at publication resolution. Open Lab figures must be
   static publication exports, not interactive HTML.

6. **Verify with the domain-check gate.** Run it on every tree/distance script you
   write, and report any finding:
   ```
   python runtime/skills/core/domain-check/domain_check.py script.py
   ```
   The gate flags Euclidean distance on unaligned sequences and trees written
   without support values — both are classic phylo errors that "run fine".

7. **report.md.** State the input file, alignment method + length, selected model
   + BIC, inference options (MFP, UFBoot, SH-aLRT), rooting rationale, and the
   key clades with their support values. Every number must trace to a command you
   actually ran or a file it produced.

## Honesty rules

- Branch lengths are substitutions per site only under the stated model; never
  relabel them as "time" unless you did a dated (molecular-clock) analysis.
- Support values and tree topology must come from the IQ-TREE output files, not
  from a narrative guess. If a clade has low support, report it as low.
- A tree built from an unaligned matrix, or with all-zero supports, is a broken
  result — say so rather than drawing a confident picture.
