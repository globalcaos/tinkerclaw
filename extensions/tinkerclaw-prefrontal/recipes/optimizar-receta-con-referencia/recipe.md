---
schema: "kit/1.0"
slug: "optimizar-receta-con-referencia"
title: "Optimizar una receta contra un documento de referencia (3 sub-agentes aislados)"
summary: "Bucle de co-evolución con AISLAMIENTO de información en sub-agentes: un generador ciego produce el documento, el orquestador analiza contra la referencia, y un modificador (sin ver documentos) refina la receta con instrucciones genéricas. Itera con criterio de parada registrado; el feedback del usuario va al conocimiento del proyecto."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "sales"
tags:
  [
    "meta",
    "receta",
    "optimizacion",
    "subagentes",
    "broca",
    "optimizar receta con referencia",
    "mejora la receta comparando con la mia",
    "afinar receta contra mi version",
    "coevolucionar documento y receta",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
---

# Optimizar una receta contra un documento de referencia (3 sub-agentes aislados)

> Bucle de co-evolución con AISLAMIENTO de información en sub-agentes: un generador ciego produce el documento, el orquestador analiza contra la referencia, y un modificador (sin ver documentos) refina la receta con instrucciones genéricas. Itera con criterio de parada registrado; el feedback del usuario va al conocimiento del proyecto.

## Goal

Refinar una receta con instrucciones lo más genéricas posibles, validando a ciegas si genera un buen documento con los datos disponibles; cada rol en un sub-agente con visibilidad e información aisladas.

## When to Use

- El usuario ha rehecho a mano el documento que generó una receta y quiere que la receta aprenda, con una prueba justa (generación a ciegas)

## Steps

### 1. Generar el documento — sub-agente CIEGO

**Tools:** Bash
**Done when:** Existe el documento generado a ciegas.

Despacha un SUB-AGENTE (helper openclaw-spawn-subagent) que recibe SOLO los datos disponibles (el conocimiento del proyecto / la info del caso) y la receta objetivo. NO puede ver la versión final del usuario NI ningún análisis comparativo. Genera el documento. La generación a ciegas es el TEST real de si la receta basta: si el generador ve la referencia, la 'convergencia' es falsa.

### 2. Análisis comparativo — orquestador (contexto completo)

**Tools:** Read, Bash
**Done when:** Tienes máximas genéricas y preguntas.

Con contexto completo (lo hace el orquestador), compara el documento generado con la versión del usuario en: nombre de fichero, estructura y secciones, nivel de detalle, vocabulario, precios y números, y contradicciones entre lo que se sabía y lo que el usuario escribió. Deriva MÁXIMAS GENÉRICAS para la receta (no datos del caso) e incluye máximas sobre el expertise de cada interlocutor. Separa lo reconciliable (a receta) de lo NO reconciliable (a cuestionario).

### 3. Modificar la receta — sub-agente (análisis + receta, SIN documentos)

**Tools:** Bash
**Done when:** La receta se re-creó con instrucciones genéricas.

Despacha un SUB-AGENTE que recibe SOLO el análisis comparativo y la receta actual, pero NO los documentos (ni el generado ni el del usuario). Reescribe la receta aplicando las máximas como instrucciones lo más GENÉRICAS posibles, y la re-crea con prefrontal.recipe.author (overwrite, desde un dir bajo ~/src/tinkerclaw). No ver los documentos fuerza la generalidad (impide copiar un caso concreto).

### 4. Iterar o parar — registrado

**Done when:** Decides iterar o parar y lo REGISTRAS con motivos.

Vuelve al paso 1 con la receta mejorada (nuevo generador ciego). El feedback del usuario es el señal de la siguiente iteración: no pares con clarificaciones pendientes. Para SOLO cuando la calidad del documento a ciegas es aceptable o el análisis ya no produce máximas significativas (señal plana). No uses 'ya converge porque existe la referencia' como excusa. Entrega un REGISTRO DE PARADA: iteraciones, qué cambió en cada una, qué disparó la parada y por qué.

### 5. Enrutar la información a su sitio

**Done when:** Cada pieza ha ido a su destino correcto.

Tres destinos distintos, no mezclar: (1) las RESPUESTAS del usuario a las incongruencias van al CONOCIMIENTO DEL PROYECTO (la ficha 'lo que sabemos'), NO al documento ni a la receta; (2) el DOCUMENTO solo cambia por lo que pida el usuario (p.ej. una errata) y se mantiene corto, sin rationale; (3) la RECETA solo recibe instrucciones genéricas. Entrega al usuario el cuestionario de incongruencias; sus respuestas reabren el bucle.

## Constraints

- Aislamiento de información: el generador NO ve la referencia ni el análisis; el modificador NO ve los documentos
- Cada rol en un sub-agente distinto (visibilidad concreta por tarea)
- La receta se refina con instrucciones lo más genéricas posibles
- Tres destinos separados: respuestas→conocimiento del proyecto; errata→documento (corto); máximas genéricas→receta
- Criterio de parada explícito y REGISTRADO
- El documento final lo revisa y aprueba el usuario

## Safety Notes

- La receta objetivo se edita vía prefrontal.recipe.author overwrite (snapshot + rollback)

## Failures Overcome

- Error de base: sin generador ciego, la 'convergencia' es falsa (el documento se copió de la referencia)
- Se metían datos del caso en la receta (debe ser genérica) y rationale en el documento (debe ir corto); las respuestas del usuario deben ir al conocimiento del proyecto, no al documento ni a la receta
- Se paró el bucle con una excusa en vez de un criterio registrado
